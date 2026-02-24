# Grover: Detailed Design

## 1. Module Architecture

### 1.1 Directory Structure

```
grover.js                          CLI dispatcher (77 lines)
src/
├── config.js                      File paths, env vars, LLM config, Keycloak config
├── domain-constants.js            Westpac financial domain vocabulary
├── domain-constants-sa.js         Services Australia domain vocabulary (33 categories)
├── utils/
│   ├── math.js                    Shared cosine similarity
│   ├── pdf.js                     PDF text extraction + page-aware chunking
│   ├── markdown.js                Markdown parsing with YAML front-matter
│   ├── chunking.js                Shared chunk boundary detection
│   ├── embed-batch.js             Batch embedding child process worker
│   ├── file-discovery.js          Recursive file finder (PDF + Markdown)
│   └── formatting.js              Result + context formatters
├── graph/
│   ├── entity-extraction.js       Domain entity extraction, category inference from filenames
│   └── knowledge-graph.js         KnowledgeGraph class (nodes, edges, traversal)
├── memory/
│   ├── conversation-memory.js     ConversationMemory class (persist, recall, SONA, feedback)
│   ├── chat-manager.js            ChatManager class (per-user multi-chat isolation)
│   └── feedback-index.js          FeedbackIndex class (content-keyed shared quality scores)
├── persistence/
│   ├── index-persistence.js       Binary embedding + JSON metadata save/load
│   └── rvf-store.js               HNSW persistent store (build, open, query, close)
├── retrieval/
│   ├── vector-search.js           Brute-force cosine distance search
│   └── retrieve.js                Orchestrates search pipeline (embed → vector → graph)
├── llm/
│   ├── client.js                  OpenAI-compatible HTTP client (streaming + non-streaming)
│   ├── query-rewrite.js           Follow-up query expansion via LLM
│   ├── rag.js                     RAG answer generation with memory + feedback integration
│   └── usage-tracker.js           UsageTracker class (per-user/model token + cost tracking)
├── server/
│   ├── viz-builder.js             Graph-to-visualization data transformer
│   ├── viz-path.js                Citation subgraph extraction for path highlighting
│   ├── chat-panel.html            Injected chat panel (HTML/CSS/JS)
│   ├── login-overlay.html         Keycloak OIDC login overlay (PKCE flow)
│   ├── auth-callback.html         OIDC callback page
│   ├── auth.js                    Keycloak OIDC validation, sessions, auth middleware
│   ├── admin-api.js               Admin routes (user CRUD, usage stats)
│   └── admin-panel.html           Admin panel HTML page
└── commands/
    ├── ingest.js                  Full PDF ingestion pipeline
    ├── update.js                  Incremental index update (add/modify/delete)
    ├── search.js                  CLI search command
    ├── ask.js                     Single-query RAG command
    ├── interactive.js             REPL mode with full command set
    ├── serve.js                   HTTP server with graph viz + chat + auth + admin
    └── stats.js                   Index statistics reporter
```

### 1.2 Dependency Graph

Dependencies flow strictly downward. No circular imports exist.

```
Layer 0: config.js, domain-constants.js, domain-constants-sa.js
    ▲
Layer 1: utils/math, utils/pdf, utils/file-discovery, utils/formatting
    ▲
Layer 2: graph/entity-extraction, graph/knowledge-graph,
         memory/conversation-memory, memory/feedback-index, memory/chat-manager
    ▲
Layer 3: persistence/index-persistence, persistence/rvf-store,
         retrieval/vector-search,
         llm/client, llm/query-rewrite, llm/rag, llm/usage-tracker,
         retrieval/retrieve
    ▲
Layer 4: server/auth, server/admin-api, server/viz-builder, server/viz-path
    ▲
Layer 5: commands/*
```

**Rules enforced:**
- `utils/` and constants depend on nothing in `src/`
- `graph/` and `memory/` depend only on Layer 0-1
- `persistence/` depends on `graph/` (for `KnowledgeGraph.fromJSON`)
- `llm/` depends on config + `utils/formatting` only
- `retrieval/` depends on `llm/query-rewrite` + `retrieval/vector-search`
- `server/auth` depends only on `config` + `jose` (lazy-loaded)
- `server/admin-api` depends on `server/auth` + `config`
- `commands/` depend on everything above, never on each other (except `update` imports `ingest` as fallback)

---

## 2. Module Specifications

### 2.1 `src/config.js`

Centralizes all file paths, environment variable reading, and Keycloak configuration.

| Export | Type | Description |
|--------|------|-------------|
| `PROJECT_ROOT` | `string` | Absolute path to project root (resolved from `__dirname`) |
| `DOCS_DIR` | `string` | Absolute path to source document directory (`<PROJECT_ROOT>/corpus`) |
| `INDEX_DIR` | `string` | Absolute path to generated index directory (`<PROJECT_ROOT>/index`) |
| `META_FILE` | `string` | `<INDEX_DIR>/metadata.json` |
| `EMBEDDINGS_FILE` | `string` | `<INDEX_DIR>/embeddings.bin` |
| `GRAPH_FILE` | `string` | `<INDEX_DIR>/graph.json` |
| `MEMORY_FILE` | `string` | `<INDEX_DIR>/memory.json` |
| `LLM_API_KEY` | `string` | `OPENAI_API_KEY` env var |
| `LLM_BASE_URL` | `string` | `OPENAI_BASE_URL` env var (default: OpenAI) |
| `LLM_MODEL` | `string` | `LLM_MODEL` env var (default: `gpt-4o-mini`) |
| `POLLY_REGION` | `string` | `AWS_REGION` env var (default: `ap-southeast-2`) |
| `POLLY_VOICE` | `string` | `POLLY_VOICE` env var (default: `Olivia`) |
| `POLLY_ENGINE` | `string` | `POLLY_ENGINE` env var (default: `neural`) |
| `KEYCLOAK_URL` | `string` | `KEYCLOAK_URL` env var (empty = auth disabled) |
| `KEYCLOAK_REALM` | `string` | `KEYCLOAK_REALM` env var (default: `grover`) |
| `KEYCLOAK_CLIENT_ID` | `string` | `KEYCLOAK_CLIENT_ID` env var (default: `grover-web`) |
| `AUTH_SESSION_TTL` | `number` | `AUTH_SESSION_TTL` env var (default: `86400000` / 24h) |
| `KEYCLOAK_ADMIN_USER` | `string` | `KEYCLOAK_ADMIN_USER` env var (default: `admin`) |
| `KEYCLOAK_ADMIN_PASSWORD` | `string` | `KEYCLOAK_ADMIN_PASSWORD` env var (default: `admin`) |
| `SESSION_FILE` | `string` | `<INDEX_DIR>/sessions.json` (overridable via `SESSION_FILE` env var) |
| `resolveIndex(name)` | `function` | Returns paths for a named index subdirectory (includes `rvfFile`) |
| `listIndexes()` | `function` | Returns available index names (scans `INDEX_DIR`) |

`resolveIndex(name)` returns: `{ metaFile, embeddingsFile, graphFile, memoryFile, rvfFile, indexDir }` where `rvfFile` is `<indexDir>/vectors.rvf`.

### 2.2 `src/domain-constants.js`

Financial domain vocabulary used for entity extraction.

| Export | Type | Count | Examples |
|--------|------|-------|---------|
| `PRODUCT_TYPES` | `string[]` | 22 | forward contract, fx swap, term deposit |
| `FINANCIAL_CONCEPTS` | `string[]` | 33 | margin call, settlement, hedging, break costs |
| `BRANDS` | `Object` | 4 | `{ wbc: 'Westpac', sgb: 'St.George Bank', ... }` |
| `CATEGORIES` | `Object` | 4 | `{ fx: 'Foreign Exchange', irrm: 'Interest Rate Risk Management', ... }` |

### 2.2a `src/domain-constants-sa.js`

Services Australia domain vocabulary.

| Export | Type | Count | Examples |
|--------|------|-------|---------|
| `PAYMENT_TYPES` | `string[]` | ~55 | age pension, jobseeker payment, medicare card |
| `GOVERNMENT_CONCEPTS` | `string[]` | ~74 | income test, waiting period, mutual obligation |
| `SA_BRANDS` | `Object` | 0 | `{}` — SA uses categories-only (no brand nodes) |
| `SA_CATEGORIES` | `Object` | 33 | `{ payments: 'Payments', centrelink: 'Centrelink', ... }` |

### 2.3 `src/utils/math.js`

Single shared implementation of cosine similarity, eliminating the duplication that previously existed between `ConversationMemory.findRelevant` and the standalone `cosineSim` function.

```
cosineSim(a: Float32Array, b: Float32Array) → number
```

Returns the cosine similarity in the range [-1, 1]. Uses epsilon `1e-8` to avoid division by zero.

### 2.4 `src/utils/pdf.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractPdfText` | `(filePath: string) → { numPages, pages[] }` | Invokes Python/pymupdf via `child_process.execFileSync`. Returns per-page text. Max buffer: 50MB. |
| `chunkPages` | `(pages[], maxChars?, overlap?) → chunk[]` | Page-aware text chunking. Default 1000 chars with 200-char overlap. Breaks at paragraph > newline > sentence boundaries. Minimum chunk size: 20 chars. Returns `{ text, pageStart, pageEnd }`. |

### 2.5 `src/utils/markdown.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseMarkdown` | `(filePath: string) → { title, url, source, numPages, pages[] }` | Parses markdown files with optional YAML front-matter (`title`, `url`, `source` fields). Returns the body as a single page. |
| `chunkText` | `(text: string, maxChars?, overlap?) → chunk[]` | Text chunking for markdown content. Default 1000 chars with 200-char overlap. Breaks at paragraph/newline/sentence boundaries. Guards against infinite loops when remaining text is shorter than overlap. Returns `{ text, pageStart, pageEnd }`. |

### 2.5a `src/utils/embed-batch.js`

Standalone child process worker for batch embedding. Isolates the ONNX WASM runtime (~4GB memory) to a short-lived process.

**Usage:** `node embed-batch.js <docsDir> <outputPrefix>`
Reads newline-delimited file paths from stdin.

**Process:**
1. Loads ONNX model via `rv.initOnnxEmbedder()` and determines embedding dimension
2. For each file: parses (PDF or Markdown), chunks, embeds each chunk
3. Writes embeddings as raw Float32LE to `<outputPrefix>.emb`
4. Writes metadata as JSON to `<outputPrefix>.json` (includes `dim`, `records[]`, `errors`)
5. Exits (OS reclaims all WASM memory)

### 2.5b `src/utils/file-discovery.js`

```
findFiles(dir: string, extension: string) → string[]
findPdfs(dir: string) → string[]
findMarkdownFiles(dir: string) → string[]
```

Generic recursive file finder with extension filter, skipping hidden directories. `findPdfs` and `findMarkdownFiles` are thin wrappers around `findFiles`.

### 2.6 `src/utils/formatting.js`

| Function | Purpose | Used By |
|----------|---------|--------|
| `formatResult(r, i, showGraph?)` | Formats a single search result for CLI display. Shows score, file, page range, graph tags, boost. | `commands/search`, `commands/interactive` |
| `formatContext(results)` | Formats results as numbered `[Source N]` blocks for LLM context. | `llm/rag` |

### 2.7 `src/graph/entity-extraction.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractEntities` | `(text: string, domain?: string) → string[]` | Uses pre-compiled word-boundary regular expressions for case-insensitive matching against domain vocabularies (Westpac or Services Australia). Returns prefixed IDs: `product:forward contract`, `concept:margin call`. Patterns are compiled once at module load via `compilePatterns()`. |
| `extractDocMeta` | `(filePath: string, domain?: string) → { brand, brandName, category, categoryName }` | Extracts brand and category from file path segments. For docs in `general/`, calls `inferCategoryFromFilename()` to attempt reclassification. |
| `inferCategoryFromFilename` | `(filename: string) → string \| null` | 4-tier category inference: (1) form codes, (2) language/translation names, (3) keyword rules (~40 ordered rules), (4) medical condition patterns. Returns category key or null. |
| `DOMAINS` | `Object` | Compiled pattern sets for both domains, keyed by domain name. |

### 2.8 `src/graph/knowledge-graph.js`

The `KnowledgeGraph` class (303 lines) is the largest module. It maintains four data structures:

| Property | Type | Description |
|----------|------|-------------|
| `nodes` | `Map<id, {type, label, meta}>` | All graph nodes |
| `edges` | `Map<source, [{target, type, weight}]>` | Adjacency list |
| `entityIndex` | `Map<entity, [chunkId]>` | Reverse index for co-occurrence |
| `docChunks` | `Map<file, [chunkId]>` | Document-to-chunk mapping |

**Node types:** `brand`, `category`, `document`, `chunk`, `product`, `concept`

**Edge types and weights:**

| Edge Type | Weight | Between |
|-----------|--------|---------|
| `belongs_to_brand` | 1.0 | document ↔ brand |
| `in_category` | 1.0 | document ↔ category |
| `part_of` / `contains` | 1.0 | chunk ↔ document |
| `mentions` | 0.8 | chunk ↔ product/concept |
| `shared_concept` | 0.5 | chunk ↔ chunk (cross-doc only) |
| `semantically_similar` | sim | chunk ↔ chunk (cosine > 0.85, cross-doc) |

**Key methods:**

| Method | Description |
|--------|-------------|
| `buildFromRecords(records)` | Constructs full graph from ingested chunk records. Creates brand/category/document/chunk/entity nodes and all edge types. Uses representative sampling (first/middle/last chunk per doc) for cross-document similarity. |
| `expandResults(vectorResults, allRecords, k)` | Graph-enhanced search. For each vector result, traverses 2 hops to find related chunks. Returns combined results scored as `vectorScore - (graphScore * 0.15)` plus a traversal path for visualization. Uses O(1) `Map<id, record>` lookup. |
| `getNeighbors(id, edgeType?, maxDepth?)` | Depth-limited BFS traversal. Returns `{id, type, weight, depth}` for each neighbor. |
| `toJSON()` / `fromJSON(data)` | Serialization via Map-to-array conversion. |

### 2.9 `src/memory/conversation-memory.js`

The `ConversationMemory` class (~208 lines) provides persistent Q&A memory with feedback integration.

**Storage:**
- `memories[]` — Full Q&A records with embeddings, quality scores, and feedback. Capped at `MAX_MEMORIES = 200` with oldest-first eviction.
- `history[]` — Last 100 role/content messages for LLM context window
- `ReasoningBank` — In-memory embedding store (rebuilt on load from persisted embeddings)
- `SonaCoordinator` — Trajectory recording for pattern learning
- `_cachedEmbedding` — Per-memory Float32Array cache, computed on load/store, excluded from serialization

**Constructor options:**
- `paths` — index paths for default memory file location
- `opts.userId` — user ID for per-user memory directories
- `opts.feedbackIndex` — shared `FeedbackIndex` instance for cross-user quality
- `opts.memoryFile` — explicit memory file override (used by `ChatManager` for per-chat files)

**Methods:**

| Method | Description |
|--------|-------------|
| `load()` | Reads memory file, rebuilds ReasoningBank from stored embeddings, caches Float32Arrays. Idempotent (skips if already loaded). |
| `save()` | Writes current state to memory file. Strips `_cachedEmbedding` fields, converts Float32Arrays to regular arrays. |
| `store(query, answer, sources, queryEmbedding)` | Stores a new Q&A interaction with unique ID (includes userId prefix). Enforces `MAX_MEMORIES` cap. Records SONA trajectory with retrieval and generation steps. Auto-saves. Returns memoryId. |
| `recordFeedback(memoryId, type, category?, comment?)` | Records feedback on a memory entry. Updates quality score, writes to shared feedback index, records SONA trajectory. Returns new quality score. |
| `findRelevant(queryEmbedding, k?)` | Returns top-k past interactions with `(cosine similarity × quality) > 0.5`. Quality is `min(per-memory quality, shared feedback index quality)`. Uses cached Float32Arrays and shared `cosineSim` from `utils/math`. |
| `getRecentHistory(n?)` | Returns last `n` messages from conversation history. |
| `stats()` | Returns memory and SONA statistics. |

### 2.9a `src/memory/chat-manager.js`

The `ChatManager` class (~197 lines) provides per-user multi-chat isolation.

**Storage:**
- `_meta` — `{ chats: [{id, title, createdAt, lastActivityAt}], activeChatId }` persisted to `chats.json`
- `_memoryCache` — `Map<chatId, ConversationMemory>` for lazy-loaded memory instances

**Methods:**

| Method | Description |
|--------|-------------|
| `load()` | Reads `chats.json`, migrates legacy `memory.json` if no chats exist, ensures at least one chat. |
| `save()` | Writes `chats.json` metadata. |
| `listChats()` | Returns all chats sorted by `lastActivityAt` descending. |
| `createChat()` | Creates a new chat with random ID, sets it as active. |
| `deleteChat(chatId)` | Deletes chat metadata and memory file. Validates chatId format to prevent path traversal. Switches active chat if needed. |
| `getMemory(chatId)` | Returns `ConversationMemory` for a specific chat (lazy-loaded, cached). |
| `getActiveMemory()` | Shortcut for `getMemory(activeChatId)`. |
| `autoTitle(chatId, query)` | Sets chat title from first query (truncated to 50 chars). |
| `renameChat(chatId, title)` | Renames a chat. |
| `touchChat(chatId)` | Updates `lastActivityAt` timestamp. |

### 2.9b `src/memory/feedback-index.js`

The `FeedbackIndex` class (~95 lines) provides a content-keyed shared quality index.

**Storage:** `feedback-index.json` — `{ [contentKey]: { quality, feedbacks[] } }`

**Methods:**

| Method | Description |
|--------|-------------|
| `computeKey(query, sources)` | SHA-256 hash of `query + sorted source files`, truncated to 16 hex chars. |
| `record(key, type, category, comment, userId, query)` | Records feedback. Positive feedback doesn't degrade quality. Negative feedback sets quality to `min(current, category-based value)`. |
| `getQuality(key)` | Returns shared quality score for a content key, or null if unknown. |
| `stats()` | Returns entry count. |

### 2.10 `src/persistence/index-persistence.js`

| Function | Description |
|----------|-------------|
| `saveIndex(records, dim, graph, paths?)` | **Async.** Writes metadata as JSON, embeddings as raw Float32 binary, graph as JSON. When `RVF_AVAILABLE` and `paths` provided, builds HNSW persistent store via `buildRvfStore()`. Creates index directory if needed. |
| `loadIndex()` | Reads metadata + binary embeddings, reconstructs Float32Arrays, deserializes graph via `KnowledgeGraph.fromJSON`. Returns `{ dim, records, graph, rvfFile }` or `null`. |
| `loadIndexWithFallback(paths, indexName)` | Loads with paths, falls back to legacy root index if indexName is `Westpac`. |

**Binary format:** Embeddings are stored as a flat `Float32LE` buffer. Record `i`, dimension `j` is at byte offset `(i * dim + j) * 4`. For 13,000+ records at 384 dimensions, this produces a ~19 MB file.

**RVF build:** When ruvector's RVF native binaries are available, `saveIndex()` also calls `buildRvfStore(paths.rvfFile, records, dim)` to create the HNSW persistent store. This is a transparent upgrade — the flat embeddings file is always written for backward compatibility and graph building.

### 2.11 `src/retrieval/vector-search.js`

```
vectorSearch(queryVec: Float32Array, records: Object[], k: number) → [{id, score, record}]
```

Brute-force cosine distance search. Computes query norm once, then iterates all records. Returns top-k results sorted by ascending distance (lower = more similar). Uses `Float64Array` for scored distances to avoid precision loss.

### 2.10a `src/persistence/rvf-store.js`

Thin wrapper around ruvector's RVF (persistent HNSW) functions. All functions are no-ops when `RVF_AVAILABLE` is `false`.

| Export | Type | Description |
|--------|------|-------------|
| `RVF_AVAILABLE` | `boolean` | `true` when `rv.isRvfAvailable()` reports native binaries present |
| `buildRvfStore(rvfPath, records, dim)` | `async function` | Creates HNSW store, ingests vectors in batches of 1,000 (IDs are string-encoded array indices), compacts, closes. Options: `{ dimensions, metric: 'cosine', m: 16, efConstruction: 200 }` |
| `openRvfStoreForQuery(rvfPath)` | `async function` | Opens an existing `.rvf` file for querying. Returns store handle or `null`. |
| `queryRvfStore(store, queryVec, k, opts?)` | `async function` | HNSW k-NN search. Returns `[{ id, distance }]`. Default `efSearch: 64`. |
| `closeRvfStore(store)` | `async function` | Closes an open store handle. |

**RVF ID scheme:** IDs must be string-encoded u64 integers. The store uses array indices (`"0"`, `"1"`, ..., `"N-1"`) as IDs. At query time, results map back to records via `records[parseInt(id, 10)]`.

### 2.12 `src/retrieval/retrieve.js`

```
retrieve(query, index, { k?, graphMode?, memory?, rvfStore? }) → { results, path, mode, queryVec }
```

Orchestrates the full retrieval pipeline:
1. Rewrites query if follow-up detected (via `rewriteQuery`)
2. Embeds query via ONNX
3. If `rvfStore` provided: runs HNSW search via `queryRvfStore()`, maps results back to `index.records[]` by parsing string IDs as array indices. Falls back to brute-force on error.
4. If no `rvfStore` or HNSW failed: runs `vectorSearch()` brute-force cosine distance
5. If graph available, runs `expandResults` for graph-boosted ranking
6. Returns results, graph traversal path (for viz), mode label (`hnsw+graph` | `hnsw` | `vector+graph` | `vector`), and `queryVec`

### 2.13 `src/llm/client.js`

Shared HTTP client for OpenAI-compatible APIs with streaming support.

| Function | Description |
|----------|-------------|
| `fetchLLM(messages, stream)` | Builds fetch request with AbortController timeout (60s). Includes `stream_options: { include_usage: true }` when streaming. |
| `streamSSE(response, onToken)` | Parses SSE stream, extracts tokens and usage data. Returns `{ content, usage }`. |
| `callLLM(messages, { stream? })` | For CLI use. In streaming mode, writes tokens to stdout. Returns `{ content, usage }`. |
| `callLLMStream(messages, onToken)` | For server use. Delegates tokens to callback. Returns `{ content, usage }`. |

Parameters: temperature 0.2, max_tokens 2048, 60s timeout via AbortController.

### 2.14 `src/llm/query-rewrite.js`

```
rewriteQuery(query, memory) → string
```

Detects follow-up queries (short queries or those starting with referential language like "what about", "same for", etc.) and rewrites them into standalone search queries using the LLM. Returns the original query unchanged if no rewrite is needed.

### 2.15 `src/llm/rag.js`

```
ragAnswer(query, results, memory?, { stream?, queryVec?, domain? }) → { answer, sources, memoryId, usage }
ragAnswerStream(query, results, memory, onToken, { queryVec?, domain? }) → { answer, sources, memoryId, usage }
getSystemPrompt(domain) → string
```

Central RAG module used by both CLI and web server. Supports domain-aware system prompts via the `domain` parameter.

**Domain prompts:**
- `Westpac` — Financial products, regulatory guidance, risk management (default)
- `ServicesAustralia` — Government payments, eligibility criteria, entitlements

Shared helpers:
- `buildRagContext()` — constructs messages array with system prompt, history, memory context, and feedback annotations
- `buildSourcesSummary()` — formats results into source metadata

All modes store the interaction in memory (if available) and return `{ answer, sources, memoryId, usage }`. When past interactions had negative feedback, the annotation "avoid repeating same issues" is included in the LLM context.

### 2.15a `src/llm/usage-tracker.js`

The `UsageTracker` class (~99 lines) provides per-user and per-model token counting with cost estimation.

**Storage:** `usage-stats.json` — `{ totals, byUser, byModel, recent[] }`

**Methods:**

| Method | Description |
|--------|-------------|
| `record(userId, model, usage)` | Accumulates prompt/completion tokens and estimated cost. Logs to console. Persists to disk. Keeps last 100 recent entries. |
| `getStats()` | Returns `{ totals, byUser, byModel, recent }`. |

Cost estimation uses built-in pricing for gpt-4o-mini, gpt-4o, gpt-4-turbo, or custom pricing via `LLM_COST_PER_1K_INPUT` / `LLM_COST_PER_1K_OUTPUT` env vars.

### 2.16 `src/server/viz-builder.js`

```
buildVizData(graph) → { nodes[], edges[] }
```

Transforms the internal knowledge graph into a visualization-friendly format:
- Excludes chunk nodes (too numerous for visualization)
- Collapses chunk-to-entity edges to document-to-entity edges
- Limits entity mention edges to top 3 per entity by accumulated weight
- Limits similarity edges to top 3 per document
- Prunes orphan entity/concept nodes with no edges
- Adds `chunkCount` to document nodes and `degree` to entity nodes

**Additional processing:**
- **Retroactive category inference**: reassigns documents classified as `general` to inferred categories via `inferCategoryFromFilename()`
- **Brand/category deduplication**: merges legacy brand nodes that duplicate category nodes (for SA graphs where `SA_BRANDS` was emptied after initial ingestion)
- **Hub suppression**: skips `category:general` if it still has >50 docs after inference

### 2.16a `src/server/viz-path.js`

```
buildCitedVizPath(graph, sources, vizData) → { nodes[], edges[] } | null
```

Extracts the subgraph of nodes and edges connected to cited source documents, for highlighting in the visualization. Includes:
1. Direct brand/category/product/concept connections from the raw graph
2. Doc-to-doc relationships (semantically_similar, shared_concept) from viz data
3. Shared entities connected to 2+ cited documents
4. Deduplicates edges by `source|target|type` key

### 2.17 `src/server/auth.js`

Keycloak OIDC authentication module. Lazy-loads `jose` for JWT/JWKS operations. Sessions are file-backed via `SessionStore`.

| Function / Class | Description |
|----------|-------------|
| `SessionStore` | File-backed session store (replaces bare `Map`). Persists to `sessions.json`. |
| `initSessionStore(filePath)` | Creates a `SessionStore`, loads existing sessions from disk, starts prune timer. |
| `getSessionStore()` | Returns the initialized store (falls back to in-memory-only if not initialized). |
| `getAuthConfig()` | Returns auth config from env vars, or null if `KEYCLOAK_URL` is not set. Computes all OIDC endpoint URLs. |
| `validateIdToken(idToken, config)` | Validates JWT against Keycloak's JWKS endpoint. Returns `{ sub, email, name, roles }`. |
| `createSession(userId, email, name, roles, ttl)` | Creates a session via `getSessionStore().set()`. Returns session ID. |
| `getSession(req)` | Looks up session from `grover_session` cookie. Checks TTL, deletes expired. Returns user object or null. |
| `requireAuth(req, res, config)` | Middleware: returns user object, or sends 401 and returns null. When auth is disabled, returns anonymous user. |
| `requireAdmin(req, res, config)` | Middleware: checks for `admin` role. Returns user or sends 401/403. When auth is disabled, returns 403. |
| `handleAuthRoute(req, res, config)` | Route handler for `/auth/callback`, `/api/auth/session`, `/api/auth/logout`, `/api/auth/me`. |

**SessionStore class:**

| Method | Description |
|--------|-------------|
| `load()` | Reads `sessions.json`, filters expired entries |
| `save()` | Writes to disk when dirty flag is set |
| `get(id)` | Returns session data |
| `has(id)` | Returns boolean |
| `set(id, session)` | Write-through: sets in Map and immediately saves to disk |
| `delete(id)` | Marks dirty (batched save via next prune cycle) |
| `pruneExpired()` | Removes expired entries, saves if any pruned |
| `startPruneTimer(interval)` | Starts periodic cleanup (default 5 min). Timer uses `.unref()` to not prevent exit. |
| `shutdown()` | Clears timer, prunes, final save |

Cookie: `grover_session`, HttpOnly, SameSite=Lax. Sessions survive server restarts via the file-backed store.

### 2.17a `src/server/admin-api.js`

Admin panel routes (~246 lines). Proxies user management operations to the Keycloak Admin REST API.

| Function | Description |
|----------|-------------|
| `handleAdminRoute(req, res, config, readBody, usageTracker)` | Route handler for all `/admin` and `/api/admin/*` routes. All routes require `admin` role. |

Uses a cached admin access token obtained via password grant from Keycloak's master realm. Token auto-refreshes 30s before expiry.

### 2.18 `src/server/chat-panel.html`

A self-contained HTML fragment containing CSS styles, HTML markup, and JavaScript for the chat panel. Injected into `graph-viz.html` at serve time via string replacement. Features:
- Message rendering with markdown-like formatting
- Source citation click-to-focus (delegates to graph-viz.html's `focusNode`)
- Graph path highlighting on query response
- Multi-chat sidebar (create, switch, rename, delete)
- Feedback buttons (thumbs up/down with categorization modal)
- Memory clear via `/api/forget`
- User session display and logout button (when auth enabled)

### 2.19 Command Modules (`src/commands/`)

| Command | Lines | Description |
|---------|-------|-------------|
| `ingest.js` | ~130 | Batch child process orchestrator: discovers files, splits into batches of 500, spawns `embed-batch.js` workers, merges results, builds graph, saves index. Parent never loads ONNX. |
| `update.js` | ~150 | Incremental: detects new/modified/deleted files by mtime, streams existing embeddings to disk, processes changes via batch child processes, merges results, rebuilds graph |
| `search.js` | 30 | Loads index, opens RVF store if available, calls `retrieve` with HNSW, prints formatted results, closes store |
| `ask.js` | 27 | Loads index + memory, calls `retrieve` + `ragAnswer` with streaming and domain parameter |
| `interactive.js` | 184 | Full REPL with flags (`--flat`, `--k N`, `--search`, `--related`, `--entities`, `--memory`, `--forget`) |
| `serve.js` | ~430 | HTTP server with auth, admin, chat management, feedback, TTS, SSE streaming, graceful shutdown. Manages per-user ChatManagers, UsageTracker, persistent sessions, and RVF HNSW store lifecycle. |
| `stats.js` | 65 | Reads index/graph/memory and prints statistics with debug logging |

---

## 3. Data Formats

### 3.1 `metadata.json`

```json
{
  "dim": 384,
  "count": 6220,
  "records": [
    {
      "id": "Westpac/wbc/fx/WBC-FXSwapPDS.pdf::chunk0",
      "file": "Westpac/wbc/fx/WBC-FXSwapPDS.pdf",
      "chunk": 0,
      "totalChunks": 15,
      "pages": 20,
      "pageStart": 1,
      "pageEnd": 2,
      "preview": "First 200 chars of chunk text...",
      "text": "Full chunk text...",
      "mtime": 1700000000000
    }
  ]
}
```

### 3.2 `embeddings.bin`

Raw binary file. `count * dim * 4` bytes. Each float is 32-bit little-endian. Record `i` starts at byte offset `i * dim * 4`.

### 3.3 `graph.json`

Serialized Maps as arrays of `[key, value]` pairs:
```json
{
  "nodes": [["brand:wbc", {"type": "brand", "label": "Westpac", "meta": {}}], ...],
  "edges": [["brand:wbc", [{"target": "doc:...", "type": "belongs_to_brand", "weight": 1}]], ...],
  "entityIndex": [["product:forward contract", ["chunk-id-1", "chunk-id-2"]], ...],
  "docChunks": [["Westpac/wbc/fx/file.pdf", ["chunk-id-1", "chunk-id-2"]], ...]
}
```

### 3.4 `chats.json`

Per-user (or per-index for anonymous) chat metadata:
```json
{
  "chats": [
    {
      "id": "chat-a1b2c3d4e5f6",
      "title": "JobSeeker eligibility requirements",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "lastActivityAt": "2025-01-01T01:00:00.000Z"
    }
  ],
  "activeChatId": "chat-a1b2c3d4e5f6"
}
```

Each chat's conversation memory is stored in a separate file: `chat-<chatId>.json` (same format as legacy `memory.json`).

### 3.5 `feedback-index.json`

```json
{
  "a1b2c3d4e5f6g7h8": {
    "quality": 0.3,
    "feedbacks": [
      {
        "type": "negative",
        "category": "wrong-answer-right-docs",
        "comment": "The answer confused two different payments",
        "userId": "user-123",
        "query": "What is the income test for JobSeeker?",
        "timestamp": "2025-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

### 3.6 `usage-stats.json`

```json
{
  "totals": {
    "promptTokens": 15000,
    "completionTokens": 5000,
    "totalTokens": 20000,
    "requests": 50,
    "estimatedCost": 0.0075
  },
  "byUser": {
    "user-123": { "promptTokens": 10000, "completionTokens": 3000, "totalTokens": 13000, "requests": 30, "estimatedCost": 0.005 }
  },
  "byModel": {
    "gpt-4o-mini": { "promptTokens": 15000, "completionTokens": 5000, "totalTokens": 20000, "requests": 50, "estimatedCost": 0.0075 }
  },
  "recent": [
    { "timestamp": "2025-01-01T00:00:00.000Z", "userId": "user-123", "model": "gpt-4o-mini", "promptTokens": 300, "completionTokens": 100, "cost": 0.0001 }
  ]
}
```

### 3.7 Per-chat memory file (`chat-<chatId>.json`)

Same format as legacy `memory.json`, with added feedback fields:
```json
{
  "history": [
    {"role": "user", "content": "...", "timestamp": "2025-01-01T00:00:00.000Z"},
    {"role": "assistant", "content": "...", "timestamp": "2025-01-01T00:00:00.000Z", "sources": [...], "memoryId": "mem-..."}
  ],
  "memories": [
    {
      "id": "mem-user123-1700000000000",
      "query": "What is a forward contract?",
      "answer": "A forward contract is...",
      "sources": [{"file": "...", "pageStart": 1, "pageEnd": 2, "score": 0.85}],
      "embedding": [0.1, 0.2, ...],
      "timestamp": "2025-01-01T00:00:00.000Z",
      "quality": 1.0,
      "feedback": {
        "type": "positive",
        "category": null,
        "comment": null,
        "timestamp": "2025-01-01T00:01:00.000Z"
      }
    }
  ]
}
```

### 3.8 `sessions.json`

File-backed session store. Written by `SessionStore` on session create and periodic prune.
```json
{
  "a1b2c3d4-e5f6-7890-abcd-ef1234567890": {
    "userId": "keycloak-sub-id",
    "email": "user@example.com",
    "name": "Jane Doe",
    "roles": ["user"],
    "createdAt": 1700000000000,
    "ttl": 86400000
  }
}
```

Entries are filtered on load: any session where `Date.now() > createdAt + ttl` is discarded. The file is stored at `<INDEX_DIR>/sessions.json` by default (overridable via `SESSION_FILE` env var). Added to `.gitignore`.

### 3.9 `vectors.rvf`

Binary HNSW persistent store created by `@ruvector/rvf`. Contains a Hierarchical Navigable Small World graph index for approximate nearest neighbor search. For 13,211 vectors at 384 dimensions, the file is ~19.5 MB.

- Built during ingestion by `buildRvfStore()` in batches of 1,000
- Parameters: `metric: 'cosine'`, `m: 16`, `efConstruction: 200`
- IDs are string-encoded array indices (`"0"` through `"N-1"`)
- Stored at `<indexDir>/vectors.rvf` per named index
- Added to `.gitignore`

### 3.10 `/api/ask` Response

```json
{
  "answer": "A forward contract is... [Source 1]...",
  "sources": [
    {"index": 1, "file": "Westpac/wbc/fx/WBC-FXSwapPDS.pdf", "pageStart": 6, "pageEnd": 6, "score": 0.15}
  ],
  "path": {
    "nodes": ["doc:Westpac/wbc/fx/WBC-FXSwapPDS.pdf", "brand:wbc", "category:fx"],
    "edges": [{"source": "doc:...", "target": "brand:wbc", "type": "belongs_to_brand"}]
  },
  "mode": "hnsw+graph",
  "memoryId": "mem-user123-1700000000000"
}
```

---

## 4. Scoring Algorithm

### 4.1 Vector Score

Cosine distance: `1 - (dot(q, e) / (||q|| * ||e||))`. Range [0, 2]. Lower is better.

### 4.2 Graph Score

Accumulated from graph traversal of each vector result (2-hop max):
- Direct neighbor (depth 0): `edge.weight * 1.0`
- Indirect neighbor (depth 1+): `edge.weight * 0.5`

### 4.3 Combined Score

```
combinedScore = vectorScore - (graphScore * 0.15)
```

The graph boost lowers the effective distance, promoting results that are both semantically similar and structurally connected through shared entities or documents.

### 4.4 Memory Relevance Score

```
memoryScore = cosineSimilarity(queryEmbedding, pastQueryEmbedding) × quality
quality = min(perMemoryQuality, sharedFeedbackQuality)
```

Only past interactions with `memoryScore > 0.5` are included in RAG context.

---

## 5. Refactoring Decisions

### 5.1 Eliminated Duplications

| Duplication | Before | After |
|------------|--------|-------|
| Cosine similarity | Inline in `ConversationMemory.findRelevant` (6 lines) + standalone `cosineSim` (8 lines) | Single `cosineSim` in `utils/math.js`, imported by both |
| RAG logic in serve | `/api/ask` handler duplicated ~25 lines of context-building, LLM calling, and memory storing from `ragAnswer` | `ragAnswer(query, results, memory, { stream: false })` — one call, returns `{ answer, sources }` |
| Chat panel HTML | 265-line template string embedded in JS | Separate `chat-panel.html` file, loaded with `fs.readFileSync` |
| Viz path building | Identical logic in `/api/ask` and `/api/ask-stream` | Shared `buildCitedVizPath()` in `src/server/viz-path.js` |
| SSE parsing | ~95% identical code in `callLLM` and `callLLMStream` | Shared `streamSSE(response, onToken)` helper |
| RAG message building | Duplicated in `ragAnswer` and `ragAnswerStream` | Shared `buildRagContext()` helper |
| Index loading | 3-line fallback pattern in 6 command files | `loadIndexWithFallback(paths, indexName)` in persistence module |

### 5.2 Module Size Distribution

No module exceeds 400 lines (serve.js with all route handlers). Most modules are under 150 lines:

| Range | Count | Modules |
|-------|-------|---------|
| 10-20 lines | 3 | math, chunking, search cmd |
| 20-50 lines | 5 | domain-constants, formatting, retrieve, ask cmd, viz-path |
| 50-120 lines | 10 | pdf, markdown, client, query-rewrite, rag, embed-batch, stats, feedback-index, usage-tracker, entity-extraction |
| 120-250 lines | 7 | config, ingest, update, interactive, conversation-memory, chat-manager, admin-api |
| 250-400 lines | 3 | knowledge-graph, auth, serve |

---

## 6. Operational Improvements

### 6.1 Batch Child Process Embedding

The ONNX WASM runtime pre-allocates ~4GB of WebAssembly memory that V8 counts against Node.js's heap limit. Previous single-process ingestion would OOM after 1-2 files because the WASM allocation left no room for actual work.

**Architecture:**
```
ingest.js (parent)                    embed-batch.js (child × N)
  │                                     │
  ├─ Discover files                     ├─ Load ONNX model (~4GB WASM)
  ├─ Split into batches of 500          ├─ For each file:
  ├─ For each batch:                    │   ├─ Parse (PDF/Markdown)
  │   ├─ Spawn child process            │   ├─ Chunk text
  │   │   (--max-old-space-size=6144)   │   ├─ Embed chunks
  │   ├─ Pipe file paths via stdin      │   └─ Write embedding to .emb
  │   ├─ Wait for child to exit         ├─ Write metadata to .json
  │   └─ Read batch results             └─ Exit (OS reclaims WASM)
  ├─ Merge all batch embeddings
  ├─ Build knowledge graph
  └─ Save index
```

### 6.2 Chunking Loop Fix

The `chunkText()` function had an infinite loop bug: when the remaining text at the end of a document was shorter than the overlap parameter (200 chars), `start = end - overlap` would not advance past the current position, creating millions of duplicate chunks. Fixed by:
1. Breaking when `end >= cleaned.length` (reached end of text)
2. Breaking when `newStart <= start` (no forward progress)
3. Renaming the inner `chunkText` variable to `slice` to avoid shadowing the function name

### 6.3 Domain-Aware RAG Prompts

The RAG system prompt is now selected based on the active index domain:
- **Westpac**: Financial products, regulatory requirements, risk management vocabulary
- **ServicesAustralia**: Government payments, eligibility criteria, entitlements vocabulary
- Shared rules: cite sources with `[Source N]`, acknowledge uncertainty, avoid speculation

### 6.4 Graceful Server Shutdown

The web server handles SIGTERM and SIGINT signals for clean shutdown:
- Stops accepting new connections
- Waits for active connections to close (5-second timeout)
- SSE streams detect client disconnects and abort LLM generation

### 6.5 Debug Logging

When `GROVER_DEBUG=1`, the system logs additional diagnostic information:
- LLM SSE parsing errors in `client.js`
- Query rewrite failures in `query-rewrite.js`
- Memory file parse errors in `stats.js`

### 6.6 Memory Optimization

- **Conversation memory cap**: `MAX_MEMORIES = 200` with oldest-first eviction prevents unbounded growth
- **Cached Float32Arrays**: Embeddings loaded from JSON are cached as `Float32Array` on the memory object, avoiding repeated conversion during similarity search
- **Streaming embeddings**: During ingestion, embeddings are written to binary temp files instead of accumulating in JS heap
- **Absolute paths**: `config.js` uses `PROJECT_ROOT` for all paths, ensuring correct resolution regardless of working directory

### 6.7 Category Inference and Graph Cleanup

- **Filename-based inference**: 4-tier system (form codes, language detection, keyword rules, medical patterns) classifies documents into 33 SA categories
- **Retroactive reassignment**: `viz-builder.js` reclassifies documents from `general` to inferred categories at serve time, even for graphs built before the inference logic existed
- **Brand/category deduplication**: merges legacy brand nodes that duplicate category nodes (artifact of SA_BRANDS being emptied after initial ingestion)
- **Hub suppression**: skips rendering `category:general` if it still has >50 documents after inference

### 6.8 Feedback-Weighted Memory Retrieval

Memory retrieval now weights cosine similarity by quality score:
- `score = cosineSimilarity × min(perMemoryQuality, sharedFeedbackQuality)`
- Negative feedback categories map to quality: wrong+wrong=0.1, wrong+right=0.3, right+wrong=0.5, incomplete=0.6
- Past interactions with negative feedback include an annotation in the LLM context warning against repeating the same issues
