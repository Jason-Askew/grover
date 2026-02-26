# Grover: Detailed Design

## 1. Module Architecture

### 1.1 Directory Structure

```
grover.js                          CLI dispatcher
config/
├── init.sql                       PostgreSQL schema (runs on fresh volume)
├── grover-seed.dump               Pre-built database dump for bootstrapping
├── grover.service                 systemd unit for Docker Compose auto-start
├── Caddyfile                      Caddy reverse proxy template (HTTPS + Let's Encrypt)
├── 01-keycloak-db.sh              Docker entrypoint: create Keycloak database
└── keycloak/                      Keycloak realm import
scripts/
├── aws-deploy.sh                  Provision EC2 Spot instance (SG, key pair, EIP)
├── aws-setup-instance.sh          Full instance setup (Docker, Caddy, .env, systemd, cron)
├── aws-backup.sh                  Daily pg_dump to S3 with retention
├── s3-sync.sh                     Push/pull corpus + seed dumps to/from S3
└── crawl-sa.js                    Services Australia web crawler
src/
├── config.js                      File paths, env vars, DATABASE_URL, Keycloak config
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
│   ├── conversation-memory.js     ConversationMemory class (PostgreSQL-backed, HNSW retrieval)
│   ├── chat-manager.js            ChatManager class (per-user multi-chat isolation)
│   └── feedback-index.js          FeedbackIndex class (content-keyed shared quality scores)
├── persistence/
│   ├── db.js                      PostgreSQL connection pool (singleton pg.Pool)
│   └── index-persistence.js       Index save/load via PostgreSQL + JSONB graph storage
├── retrieval/
│   └── retrieve.js                Hybrid search pipeline (HNSW + BM25 RRF + graph expansion)
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
│   ├── auth.js                    Keycloak OIDC validation, PostgreSQL-backed sessions, auth middleware
│   ├── admin-api.js               Admin routes (user CRUD, usage stats)
│   └── admin-panel.html           Admin panel HTML page
└── commands/
    ├── bootstrap.js               Restore database from pg_dump seed file
    ├── ingest.js                  Full ingestion pipeline (dual-path: in-process or batched)
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
Layer 0: config.js, domain-constants.js, domain-constants-sa.js, persistence/db.js
    ▲
Layer 1: utils/math, utils/pdf, utils/file-discovery, utils/formatting
    ▲
Layer 2: graph/entity-extraction, graph/knowledge-graph,
         memory/conversation-memory, memory/feedback-index, memory/chat-manager
    ▲
Layer 3: persistence/index-persistence,
         llm/client, llm/query-rewrite, llm/rag, llm/usage-tracker,
         retrieval/retrieve
    ▲
Layer 4: server/auth, server/admin-api, server/viz-builder, server/viz-path
    ▲
Layer 5: commands/*
```

**Rules enforced:**
- `utils/` and constants depend on nothing in `src/` (except `config.js`)
- `persistence/db.js` depends only on `pg` (npm)
- `graph/` and `memory/` depend on Layer 0-1 and `persistence/db`
- `persistence/index-persistence.js` depends on `db`, `graph/knowledge-graph`
- `llm/` depends on config + `utils/formatting` only
- `retrieval/` depends on `llm/query-rewrite` + `persistence/db`
- `server/auth` depends on `config` + `persistence/db` + `jose` (lazy-loaded)
- `server/admin-api` depends on `server/auth` + `config`
- `commands/` depend on everything above, never on each other (except `update` imports `ingest` as fallback)

---

## 2. Module Specifications

### 2.1 `src/persistence/db.js`

Singleton PostgreSQL connection pool using `pg.Pool`.

| Export | Type | Description |
|--------|------|-------------|
| `getPool()` | `function` | Returns the shared `pg.Pool` instance (created on first call) |
| `query(text, params)` | `async function` | Executes a parameterized query via the pool |
| `getClient()` | `async function` | Acquires a client from the pool (for transactions). Caller must call `client.release()`. |
| `closePool()` | `async function` | Closes the pool (for graceful shutdown) |
| `initDb()` | `async function` | Tests connection, verifies ruvector extension, and calls `ensureSchema()`. Throws if extension missing. |

Pool configuration: `max: 20`, `idleTimeoutMillis: 30000`. Connection string from `DATABASE_URL` env var (default: `postgres://grover:grover@localhost:5432/grover`).

The `ensureSchema()` function (called by `initDb()`) creates all tables, columns, and indexes using `IF NOT EXISTS` / `IF NOT EXISTS` patterns. This is idempotent and safe to call on every startup — it protects against `init.sql` not running (e.g., existing PostgreSQL volume) or schema changes between versions.

### 2.2 `src/config.js`

Centralizes all file paths, environment variable reading, and Keycloak configuration.

| Export | Type | Description |
|--------|------|-------------|
| `PROJECT_ROOT` | `string` | Absolute path to project root (resolved from `__dirname`) |
| `DOCS_DIR` | `string` | Absolute path to source document directory (`<PROJECT_ROOT>/corpus`) |
| `INDEX_DIR` | `string` | Absolute path to index directory (`<PROJECT_ROOT>/index`) — used for batch temp files only |
| `DATABASE_URL` | `string` | PostgreSQL connection string (from env var, default: `postgres://grover:grover@localhost:5432/grover`) |
| `LLM_API_KEY` | `string` | `OPENAI_API_KEY` env var |
| `LLM_BASE_URL` | `string` | `OPENAI_BASE_URL` env var (default: OpenAI) |
| `LLM_MODEL` | `string` | `LLM_MODEL` env var (default: `gpt-4o-mini`) |
| `KEYCLOAK_URL` | `string` | `KEYCLOAK_URL` env var (empty = auth disabled) |
| `KEYCLOAK_PUBLIC_URL` | `string` | Browser-facing Keycloak URL (defaults to `KEYCLOAK_URL`) |
| `resolveIndex(name)` | `function` | Returns paths for a named index subdirectory (temp files during ingest) |
| `listIndexes()` | `function` | Returns available index names (scans `INDEX_DIR` for legacy file-based indexes) |
| `listIndexesPg()` | `async function` | Returns available index names from PostgreSQL (`SELECT DISTINCT index_name FROM documents`) |

### 2.3 `src/domain-constants.js`

Financial domain vocabulary used for entity extraction.

| Export | Type | Count | Examples |
|--------|------|-------|---------|
| `PRODUCT_TYPES` | `string[]` | 22 | forward contract, fx swap, term deposit |
| `FINANCIAL_CONCEPTS` | `string[]` | 33 | margin call, settlement, hedging, break costs |
| `BRANDS` | `Object` | 4 | `{ wbc: 'Westpac', sgb: 'St.George Bank', ... }` |
| `CATEGORIES` | `Object` | 4 | `{ fx: 'Foreign Exchange', irrm: 'Interest Rate Risk Management', ... }` |

### 2.3a `src/domain-constants-sa.js`

Services Australia domain vocabulary.

| Export | Type | Count | Examples |
|--------|------|-------|---------|
| `PAYMENT_TYPES` | `string[]` | ~55 | age pension, jobseeker payment, medicare card |
| `GOVERNMENT_CONCEPTS` | `string[]` | ~74 | income test, waiting period, mutual obligation |
| `SA_BRANDS` | `Object` | 0 | `{}` — SA uses categories-only (no brand nodes) |
| `SA_CATEGORIES` | `Object` | 33 | `{ payments: 'Payments', centrelink: 'Centrelink', ... }` |

### 2.4 `src/utils/math.js`

Single shared implementation of cosine similarity.

```
cosineSim(a: Float32Array, b: Float32Array) → number
```

Returns the cosine similarity in the range [-1, 1]. Uses epsilon `1e-8` to avoid division by zero.

### 2.5 `src/utils/pdf.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractPdfText` | `(filePath: string) → { numPages, pages[] }` | Invokes Python/pymupdf via `child_process.execFileSync`. Returns per-page text. Max buffer: 50MB. |
| `chunkPages` | `(pages[], maxChars?, overlap?) → chunk[]` | Page-aware text chunking. Default 1000 chars with 200-char overlap. Breaks at paragraph > newline > sentence boundaries. Minimum chunk size: 20 chars. Returns `{ text, pageStart, pageEnd }`. |

### 2.6 `src/utils/markdown.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseMarkdown` | `(filePath: string) → { title, url, source, numPages, pages[] }` | Parses markdown files with optional YAML front-matter (`title`, `url`, `source` fields). Returns the body as a single page. |
| `chunkText` | `(text: string, maxChars?, overlap?) → chunk[]` | Text chunking for markdown content. Default 1000 chars with 200-char overlap. Breaks at paragraph/newline/sentence boundaries. Returns `{ text, pageStart, pageEnd }`. |

### 2.7 `src/utils/embed-batch.js`

Standalone child process worker for batch embedding. Isolates the ONNX WASM runtime (~4GB memory) to a short-lived process.

**Usage:** `node embed-batch.js <docsDir> <outputPrefix>`
Reads newline-delimited file paths from stdin.

**Process:**
1. Loads ONNX model via `rv.initOnnxEmbedder()` and determines embedding dimension
2. For each file: parses (PDF or Markdown), chunks, embeds each chunk
3. Writes embeddings as raw Float32LE to `<outputPrefix>.emb`
4. Writes metadata as JSON to `<outputPrefix>.json` (includes `dim`, `records[]`, `errors`)
5. Exits (OS reclaims all WASM memory)

### 2.8 `src/utils/formatting.js`

| Function | Purpose | Used By |
|----------|---------|--------|
| `formatResult(r, i, showGraph?)` | Formats a single search result for CLI display. Shows score, file, page range, graph tags, boost. | `commands/search`, `commands/interactive` |
| `formatContext(results)` | Formats results as numbered `[Source N]` blocks for LLM context. | `llm/rag` |

### 2.9 `src/graph/entity-extraction.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractEntities` | `(text: string, domain?: string) → string[]` | Uses pre-compiled word-boundary regular expressions for case-insensitive matching against domain vocabularies. Returns prefixed IDs: `product:forward contract`, `concept:margin call`. |
| `extractDocMeta` | `(filePath: string, domain?: string) → { brand, brandName, category, categoryName }` | Extracts brand and category from file path segments. For docs in `general/`, calls `inferCategoryFromFilename()`. |
| `inferCategoryFromFilename` | `(filename: string) → string \| null` | 4-tier category inference: (1) form codes, (2) language/translation names, (3) keyword rules (~40 ordered rules), (4) medical condition patterns. |

### 2.10 `src/graph/knowledge-graph.js`

The `KnowledgeGraph` class maintains four data structures:

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
| `buildFromRecords(records)` | Constructs full graph from ingested chunk records. Creates all node and edge types. Uses representative sampling for cross-document similarity. |
| `expandResults(vectorResults, allRecords, k)` | Graph-enhanced search. For each vector result, traverses 2 hops. Returns combined results scored as `vectorScore - (graphScore * 0.15)`. Uses O(1) `Map<id, record>` lookup. |
| `getNeighbors(id, edgeType?, maxDepth?)` | Depth-limited BFS traversal. Returns `{id, type, weight, depth}` for each neighbor. |
| `toJSON()` / `fromJSON(data)` | Serialization via Map-to-array conversion. Used for graph persistence as JSONB in the `graphs` table. |

### 2.11 `src/memory/conversation-memory.js`

The `ConversationMemory` class provides PostgreSQL-backed Q&A memory with HNSW retrieval and feedback integration.

**Constructor:** `new ConversationMemory(chatId, opts)`
- `chatId` — the chat this memory belongs to (links to `chats` table)
- `opts.userId` — user ID for memory entry prefixing
- `opts.feedbackIndex` — shared `FeedbackIndex` instance for cross-user quality

**Methods:**

| Method | Description |
|--------|-------------|
| `store(query, answer, sources, queryEmbedding)` | INSERT into `memories` table (with `embedding::ruvector`) + INSERT into `chat_messages` (user + assistant). Enforces `MAX_MEMORIES = 200` cap per chat with LRU eviction. Returns memoryId. |
| `recordFeedback(memoryId, type, category?, comment?)` | UPDATE `memories` SET quality + feedback. Writes to shared feedback index. Returns new quality. |
| `findRelevant(queryEmbedding, k?)` | PostgreSQL HNSW search: `ORDER BY embedding <=> $1::ruvector`. Returns top-k past interactions with `(similarity × quality) > 0.5`. Quality is `min(per-memory quality, shared feedback index quality)`. |
| `getRecentHistory(n?)` | SELECT from `chat_messages` ORDER BY created_at DESC LIMIT n. Returns in chronological order. |
| `stats()` | Returns count of memories and messages for this chat. |

### 2.12 `src/memory/chat-manager.js`

The `ChatManager` class provides per-user multi-chat isolation backed by PostgreSQL.

**Constructor:** `new ChatManager(indexName, userId, feedbackIndex)`

**Methods:**

| Method | Description |
|--------|-------------|
| `load()` | Ensures at least one chat exists. Sets active chat from `is_active` flag or most recent. |
| `listChats()` | SELECT from `chats` ORDER BY last_activity_at DESC. |
| `createChat()` | INSERT INTO `chats`. Deactivates previous active chat. Returns new chat object. |
| `deleteChat(chatId)` | DELETE FROM `chats` (cascades to messages + memories). Validates chatId format. Switches active chat if needed. |
| `getMemory(chatId)` | Returns `ConversationMemory` for a specific chat (lazy-loaded, cached in Map). |
| `getActiveMemory()` | Shortcut for `getMemory(activeChatId)`. |
| `autoTitle(chatId, query)` | Sets chat title from first query (truncated to 50 chars). |
| `renameChat(chatId, title)` | UPDATE chats SET title. |
| `touchChat(chatId)` | UPDATE chats SET last_activity_at = NOW(). |
| `setActiveChatId(chatId)` | UPDATE chats SET is_active. |

### 2.13 `src/memory/feedback-index.js`

The `FeedbackIndex` class provides a content-keyed shared quality index backed by PostgreSQL.

**Constructor:** `new FeedbackIndex()` (no arguments; PostgreSQL-backed)

**Methods:**

| Method | Description |
|--------|-------------|
| `computeKey(query, sources)` | SHA-256 hash of `query + sorted source files`, truncated to 16 hex chars. |
| `record(key, type, category, comment, userId, query)` | INSERT INTO `feedback` ... ON CONFLICT DO UPDATE. Appends feedback to JSONB array. Quality degrades to `LEAST(current, new)`. |
| `getQuality(key)` | SELECT quality FROM `feedback` WHERE content_key = $1. Returns null if unknown. |
| `stats()` | Returns entry count from `feedback` table. |

### 2.14 `src/persistence/index-persistence.js`

| Function | Description |
|----------|-------------|
| `saveIndex(records, dim, graph, paths?, indexName?)` | **Async.** PostgreSQL transaction: DELETE existing data for index, batch INSERT documents (500/batch) with `Math.round(mtime)` for BIGINT compatibility, batch INSERT chunks with `embedding::ruvector` (500/batch). COMMIT or ROLLBACK. Graph is saved **separately** after the main transaction — a graph failure won't roll back chunk data. |
| `loadIndex(paths?, indexName?)` | **Async.** SELECT chunks + documents from PostgreSQL. Reconstructs records array with same shape as ingestion output. Parses `ruvector` column back to Float32Array via `parseRuvectorToFloat32()`. Loads graph via `loadGraph()`. Returns `{ dim, records, graph }` or null. |
| `loadIndexWithFallback(paths, indexName)` | **Async.** Delegates to `loadIndex()`. |

**Graph persistence:** The knowledge graph is serialized as JSONB in the `graphs` table:

`saveGraph(graph, indexName)`:
1. Serializes graph nodes and edges as a JSON object: `{ nodes: { id: {type, label, meta} }, edges: { sourceId: [{target, type, weight}] } }`
2. `INSERT INTO graphs (index_name, data, node_count, edge_count, created_at) VALUES (...) ON CONFLICT (index_name) DO UPDATE`

`loadGraph(indexName)`:
1. `SELECT data FROM graphs WHERE index_name = $1`
2. Reconstructs `KnowledgeGraph` instance from JSONB — restores nodes, edges, `docChunks`, and `entityIndex` maps
3. Returns null if no graph exists for the index

**Note:** Graph save is performed outside the main chunk transaction. This design ensures that a graph serialization failure (e.g., very large graph) does not roll back the successfully inserted chunks and documents.

### 2.15 `src/retrieval/retrieve.js`

```
retrieve(query, index, { k?, graphMode?, memory?, indexName? }) → { results, path, mode, queryVec }
```

Orchestrates the full retrieval pipeline:
1. Rewrites query if follow-up detected (via `rewriteQuery`)
2. Embeds query via ONNX (`rv.embed()`)
3. Executes PostgreSQL hybrid search: HNSW vector + BM25 text, fused via RRF
4. If graph available, runs `expandResults` for graph-boosted ranking
5. Returns results, graph traversal path (for viz), mode label (`hybrid+graph` | `hybrid`), and `queryVec`

**Hybrid search SQL** (simplified):
```sql
WITH vector_results AS (
  SELECT ... c.embedding <=> $1::ruvector AS distance ...
  ORDER BY c.embedding <=> $1::ruvector LIMIT $3
),
text_results AS (
  SELECT ... ts_rank(c.tsv, plainto_tsquery('english', $4)) AS text_rank ...
  WHERE c.tsv @@ plainto_tsquery('english', $4) ...
),
ranked AS (
  SELECT *, 1.0 / (60 + ROW_NUMBER() OVER (...)) AS rrf_score FROM vector_results
  UNION ALL
  SELECT *, 1.0 / (60 + ROW_NUMBER() OVER (...)) AS rrf_score FROM text_results
),
fused AS (
  SELECT ..., SUM(rrf_score) AS combined_rrf FROM ranked GROUP BY ...
)
SELECT * FROM fused ORDER BY combined_rrf DESC LIMIT $3
```

### 2.16 `src/llm/client.js`

Shared HTTP client for OpenAI-compatible APIs with streaming support.

| Function | Description |
|----------|-------------|
| `fetchLLM(messages, stream)` | Builds fetch request with AbortController timeout (60s). Includes `stream_options: { include_usage: true }` when streaming. |
| `streamSSE(response, onToken)` | Parses SSE stream, extracts tokens and usage data. Returns `{ content, usage }`. |
| `callLLM(messages, { stream? })` | For CLI use. In streaming mode, writes tokens to stdout. Returns `{ content, usage }`. |
| `callLLMStream(messages, onToken)` | For server use. Delegates tokens to callback. Returns `{ content, usage }`. |

Parameters: temperature 0.2, max_tokens 2048, 60s timeout via AbortController.

### 2.17 `src/llm/query-rewrite.js`

```
rewriteQuery(query, memory) → string
```

Detects follow-up queries and rewrites them into standalone search queries using the LLM. Returns the original query unchanged if no rewrite is needed.

### 2.18 `src/llm/rag.js`

```
ragAnswer(query, results, memory?, { stream?, queryVec?, domain? }) → { answer, sources, memoryId, usage }
ragAnswerStream(query, results, memory, onToken, { queryVec?, domain? }) → { answer, sources, memoryId, usage }
getSystemPrompt(domain) → string
```

Central RAG module. Supports domain-aware system prompts via the `domain` parameter.

**Domain prompts:**
- `Westpac` — Financial products, regulatory guidance, risk management
- `ServicesAustralia` — Government payments, eligibility criteria, entitlements

Shared helpers:
- `buildRagContext()` — constructs messages array with system prompt, history, memory context, and feedback annotations
- `buildSourcesSummary()` — formats results into source metadata

All modes store the interaction in memory (if available) and return `{ answer, sources, memoryId, usage }`. Accepts optional `queryVec` to avoid re-embedding the query.

### 2.19 `src/llm/usage-tracker.js`

The `UsageTracker` class provides per-user and per-model token counting, backed by PostgreSQL.

**Constructor:** `new UsageTracker()` (no arguments; PostgreSQL-backed)

**Methods:**

| Method | Description |
|--------|-------------|
| `record(userId, model, usage)` | INSERT INTO `usage_stats`. Estimates cost from built-in model pricing or custom env vars. |
| `getStats()` | Aggregate queries: totals, byUser, byModel, recent (last 100). All async via `db.query()`. |

### 2.20 `src/server/auth.js`

Keycloak OIDC authentication module. Sessions are PostgreSQL-backed via `SessionStore`.

| Function / Class | Description |
|----------|-------------|
| `SessionStore` | PostgreSQL-backed session store. All methods are async. |
| `initSessionStore()` | Creates a `SessionStore`, prunes expired sessions, starts prune timer. Async. |
| `getSessionStore()` | Returns the initialized store. |
| `getAuthConfig()` | Returns auth config from env vars, or null if `KEYCLOAK_URL` is not set. |
| `validateIdToken(idToken, config)` | Validates JWT against Keycloak's JWKS endpoint. Returns `{ sub, email, name, roles }`. |
| `createSession(userId, email, name, roles, ttl)` | Async. Creates a session via `getSessionStore().set()`. Returns session ID. |
| `getSession(req)` | Async. Looks up session from `grover_session` cookie. Checks TTL, deletes expired. |
| `requireAuth(req, res, config)` | Async middleware. Checks (in order): (1) if auth disabled, returns anonymous user; (2) if `GROVER_API_KEY` set and `Authorization: Bearer <key>` matches, returns API user with `userId` from `X-Grover-User` header (default `_api`); (3) session cookie lookup. Returns user object, or sends 401 and returns null. |
| `requireAdmin(req, res, config)` | Async middleware. Checks for `admin` role. Returns user or sends 401/403. |
| `handleAuthRoute(req, res, config)` | Async route handler for auth endpoints. |

**SessionStore methods:**

| Method | Description |
|--------|-------------|
| `load()` | Prunes expired sessions, logs count from PostgreSQL |
| `get(id)` | SELECT FROM `sessions` WHERE id = $1 |
| `has(id)` | Async (returns Promise<boolean>) — delegates to `get()` |
| `set(id, session)` | INSERT ... ON CONFLICT DO UPDATE into `sessions` |
| `delete(id)` | DELETE FROM `sessions` WHERE id = $1 |
| `pruneExpired()` | DELETE FROM `sessions` WHERE created_at + ttl < now |
| `startPruneTimer(interval)` | Starts periodic cleanup (default 5 min). Timer uses `.unref()`. |
| `shutdown()` | Clears timer, final prune |

Cookie: `grover_session`, HttpOnly, SameSite=Lax. Sessions survive server restarts via PostgreSQL.

### 2.21 `src/server/admin-api.js`

Admin panel routes. Proxies user management operations to the Keycloak Admin REST API. All routes require `admin` role (checked via async `requireAdmin()`).

### 2.22 `src/server/viz-builder.js`

```
buildVizData(graph) → { nodes[], edges[] }
```

Transforms the internal knowledge graph into a visualization-friendly format:
- Excludes chunk nodes (too numerous for visualization)
- Collapses chunk-to-entity edges to document-to-entity edges
- Limits entity mention edges to top 3 per entity
- Limits similarity edges to top 3 per document
- Prunes orphan entity/concept nodes
- Performs retroactive category inference and brand/category deduplication

### 2.23 `src/server/viz-path.js`

```
buildCitedVizPath(graph, sources, vizData) → { nodes[], edges[] } | null
```

Extracts the subgraph of nodes and edges connected to cited source documents, for highlighting in the visualization.

### 2.24 Command Modules (`src/commands/`)

| Command | Description |
|---------|-------------|
| `ingest.js` | Dual-path ingestion: discovers files, embeds via in-process (PDFs/small corpora) or batch child processes (large markdown corpora), builds graph, saves to PostgreSQL via `saveIndex()`. Calls `initDb()` on startup. |
| `update.js` | Incremental: detects new/modified/deleted files by comparing corpus against `SELECT file, mtime FROM documents`. Processes changes via batch child processes, merges, rebuilds graph, saves to PostgreSQL. |
| `search.js` | Calls `initDb()`, loads index from PostgreSQL, calls `retrieve()` with indexName, prints formatted results. |
| `ask.js` | Calls `initDb()`, creates temporary chat in PostgreSQL, calls `retrieve()` + `ragAnswer()`, cleans up temp chat. |
| `interactive.js` | Full REPL with flags (`--flat`, `--k N`, `--search`, `--related`, `--entities`, `--memory`, `--forget`). Creates temp chat in PostgreSQL. Calls `initDb()` on startup. |
| `serve.js` | HTTP server with auth, admin, chat management, feedback, TTS, SSE streaming, graceful shutdown. Calls `initDb()` on startup. Manages per-user ChatManagers, UsageTracker, PostgreSQL sessions. On shutdown, prunes sessions and calls `closePool()`. |
| `stats.js` | Queries PostgreSQL for chunk/document counts, table sizes via `pg_size_pretty`, graph stats, and conversation data counts (chats, messages, memories). |
| `bootstrap.js` | Restores database from a `pg_dump` seed file (default: `config/grover-seed.dump`). Checks if data exists first (`SELECT count(id) FROM chunks` — uses `count(id)` due to ruvector `count(*)` bug). Runs `pg_restore --no-owner --no-privileges`. Calls `initDb()` on startup. |

---

## 3. Data Formats

### 3.1 PostgreSQL Schema (`config/init.sql`)

#### `documents` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `SERIAL PRIMARY KEY` | Auto-incrementing document ID |
| `index_name` | `TEXT NOT NULL` | Index this document belongs to |
| `file` | `TEXT NOT NULL` | Relative file path within corpus |
| `page_count` | `INT` | Number of pages in source document |
| `mtime` | `BIGINT` | File modification time (for incremental updates) |
| `url` | `TEXT` | Source URL (from markdown front-matter) |
| `title` | `TEXT` | Document title |
| `created_at` | `TIMESTAMPTZ` | Insertion timestamp |

Unique constraint: `(index_name, file)`.

#### `chunks` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `SERIAL PRIMARY KEY` | Auto-incrementing chunk ID |
| `index_name` | `TEXT NOT NULL` | Index this chunk belongs to |
| `document_id` | `INT REFERENCES documents(id) ON DELETE CASCADE` | Parent document |
| `chunk_index` | `INT NOT NULL` | Position within document (0-based) |
| `total_chunks` | `INT` | Total chunks in parent document |
| `content` | `TEXT NOT NULL` | Full chunk text |
| `preview` | `TEXT` | First 200 chars of chunk text |
| `page_start` | `INT` | Starting page number |
| `page_end` | `INT` | Ending page number |
| `pages` | `INT` | Total pages in parent document |
| `embedding` | `ruvector(384)` | ONNX embedding (all-MiniLM-L6-v2) |
| `tsv` | `tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` | Full-text search vector |
| `created_at` | `TIMESTAMPTZ` | Insertion timestamp |

Indexes:
- `chunks_embedding_idx` — `USING hnsw (embedding ruvector_cosine_ops) WITH (m = 16, ef_construction = 200)`
- `chunks_tsv_idx` — `USING gin(tsv)`
- `chunks_index_name_idx` — B-tree on `index_name`

#### `sessions` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT PRIMARY KEY` | Session UUID |
| `user_id` | `TEXT NOT NULL` | Keycloak subject ID |
| `email` | `TEXT` | User email |
| `name` | `TEXT` | User display name |
| `roles` | `JSONB DEFAULT '[]'` | Keycloak realm roles |
| `created_at` | `BIGINT NOT NULL` | Creation timestamp (ms since epoch) |
| `ttl` | `BIGINT NOT NULL` | Time-to-live (ms) |

#### `chats` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT PRIMARY KEY` | Chat ID (format: `chat-<uuid12>`) |
| `index_name` | `TEXT NOT NULL` | Index this chat is associated with |
| `user_id` | `TEXT NOT NULL` | Owner user ID |
| `title` | `TEXT` | Chat title (auto-set from first query) |
| `created_at` | `TIMESTAMPTZ` | Creation timestamp |
| `last_activity_at` | `TIMESTAMPTZ` | Last activity timestamp |
| `is_active` | `BOOLEAN DEFAULT false` | Whether this is the user's active chat |

Index: `chats_user_idx` on `(index_name, user_id)`.

#### `chat_messages` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `SERIAL PRIMARY KEY` | Auto-incrementing message ID |
| `chat_id` | `TEXT REFERENCES chats(id) ON DELETE CASCADE` | Parent chat |
| `role` | `TEXT NOT NULL` | `'user'` or `'assistant'` |
| `content` | `TEXT NOT NULL` | Message text |
| `sources` | `JSONB` | Source citations (assistant messages only) |
| `memory_id` | `TEXT` | Associated memory entry ID |
| `created_at` | `TIMESTAMPTZ` | Message timestamp |

#### `memories` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT PRIMARY KEY` | Memory ID (format: `mem-<userId8>-<timestamp>`) |
| `chat_id` | `TEXT REFERENCES chats(id) ON DELETE CASCADE` | Parent chat |
| `query` | `TEXT NOT NULL` | User's question |
| `answer` | `TEXT NOT NULL` | Generated answer |
| `sources` | `JSONB` | Source citations |
| `embedding` | `ruvector(384)` | Query embedding for HNSW similarity search |
| `quality` | `FLOAT DEFAULT 1.0` | Quality score (degraded by negative feedback) |
| `feedback` | `JSONB` | Feedback data (type, category, comment, timestamp) |
| `created_at` | `TIMESTAMPTZ` | Creation timestamp |

Index: `memories_embedding_idx` — `USING hnsw (embedding ruvector_cosine_ops) WITH (m = 16, ef_construction = 64)`

#### `feedback` table

| Column | Type | Description |
|--------|------|-------------|
| `content_key` | `TEXT PRIMARY KEY` | SHA-256 hash of query + sorted source files (16 hex chars) |
| `quality` | `FLOAT DEFAULT 1.0` | Shared quality score (minimum across all feedbacks) |
| `feedbacks` | `JSONB DEFAULT '[]'` | Array of feedback entries |

#### `usage_stats` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | `SERIAL PRIMARY KEY` | Auto-incrementing ID |
| `user_id` | `TEXT NOT NULL` | User who made the request |
| `model` | `TEXT NOT NULL` | LLM model used |
| `prompt_tokens` | `INT DEFAULT 0` | Prompt token count |
| `completion_tokens` | `INT DEFAULT 0` | Completion token count |
| `cost` | `FLOAT DEFAULT 0` | Estimated cost |
| `created_at` | `TIMESTAMPTZ` | Request timestamp |

#### `graphs` table

| Column | Type | Description |
|--------|------|-------------|
| `index_name` | `TEXT PRIMARY KEY` | Index this graph belongs to |
| `data` | `JSONB NOT NULL` | Serialized graph: `{ nodes: { id: {type, label, meta} }, edges: { sourceId: [{target, type, weight}] } }` |
| `node_count` | `INT DEFAULT 0` | Number of nodes (for stats display) |
| `edge_count` | `INT DEFAULT 0` | Number of edges (for stats display) |
| `created_at` | `TIMESTAMPTZ` | Last rebuild timestamp |

One row per index. The graph is rebuilt on each full ingest and saved separately from the chunk transaction.

### 3.2 `/api/ask` Response

```json
{
  "answer": "A forward contract is... [Source 1]...",
  "sources": [
    {"index": 1, "file": "Westpac/wbc/fx/WBC-FXSwapPDS.pdf", "url": "", "pageStart": 6, "pageEnd": 6, "score": 0.15}
  ],
  "path": {
    "nodes": ["doc:Westpac/wbc/fx/WBC-FXSwapPDS.pdf", "brand:wbc", "category:fx"],
    "edges": [{"source": "doc:...", "target": "brand:wbc", "type": "belongs_to_brand"}]
  },
  "mode": "hybrid+graph",
  "memoryId": "mem-user123-1700000000000"
}
```

---

## 4. Scoring Algorithm

### 4.1 Hybrid Search (RRF)

Vector and text results are each ranked independently. Each result gets an RRF score:
```
rrf_score = 1 / (60 + rank)
```

For results appearing in both lists, their RRF scores are summed. Final results are ordered by descending `combined_rrf`.

### 4.2 Graph Score

Accumulated from graph traversal of each hybrid result (2-hop max):
- Direct neighbor (depth 0): `edge.weight * 1.0`
- Indirect neighbor (depth 1+): `edge.weight * 0.5`

### 4.3 Combined Score

```
combinedScore = vectorScore - (graphScore * 0.15)
```

The graph boost lowers the effective distance, promoting results that are both semantically similar and structurally connected through shared entities or documents.

### 4.4 Memory Relevance Score

```
memoryScore = (1 - hnswDistance) × quality
quality = min(perMemoryQuality, sharedFeedbackQuality)
```

Only past interactions with `memoryScore > 0.5` are included in RAG context.

---

## 5. Operational Improvements

### 5.1 Dual-Path Embedding

```
ingest.js (parent)
  │
  ├─ Discover files (PDFs + Markdown)
  │
  ├─ Route: PDFs present OR ≤500 files?
  │   │
  │   ├── YES → ingestInProcess()
  │   │         │
  │   │         ├─ Load ONNX model once (~4GB WASM)
  │   │         ├─ For each file:
  │   │         │   ├─ Parse (PDF/Markdown)
  │   │         │   ├─ Chunk text
  │   │         │   └─ Embed chunks (rv.embed)
  │   │         └─ Return records + dim
  │   │
  │   └── NO → ingestBatched()
  │             │
  │             ├─ Split into batches of 500
  │             ├─ For each batch:
  │             │   ├─ Spawn child process
  │             │   │   (--max-old-space-size=4096)
  │             │   ├─ Child: load ONNX → embed → write .emb/.json → exit
  │             │   └─ Parent: read batch results
  │             ├─ Merge all batch embeddings
  │             └─ Return records + dim
  │
  ├─ Build knowledge graph
  └─ Save to PostgreSQL
      ├─ Transaction: documents + chunks (batch 500/stmt)
      └─ Separate: graph as JSONB in graphs table
```

### 5.2 PostgreSQL Persistence

All state is stored in PostgreSQL. Benefits over the previous file-based approach:
- **Transactions** for atomic index updates (full re-ingest or rollback)
- **Concurrent access** for multi-user web UI
- **Backup/restore** via standard PostgreSQL tools
- **HNSW indexing** built into the database (no separate RVF store lifecycle)
- **BM25 full-text search** via built-in `tsvector` + GIN index
- **Graph storage** as JSONB in the `graphs` table (one row per index)

### 5.3 Graceful Server Shutdown

The web server handles SIGTERM and SIGINT signals:
- Prunes expired sessions via PostgreSQL
- Closes the PostgreSQL connection pool
- Stops accepting new connections (5-second timeout)
- SSE streams detect client disconnects and abort LLM generation

### 5.4 Domain-Aware RAG Prompts

The RAG system prompt is selected based on the active index domain:
- **Westpac**: Financial products, regulatory requirements, risk management vocabulary
- **ServicesAustralia**: Government payments, eligibility criteria, entitlements vocabulary
- Shared rules: cite sources with `[Source N]`, acknowledge uncertainty, avoid speculation

### 5.5 Feedback-Weighted Memory Retrieval

Memory retrieval weights HNSW similarity by quality score:
- `score = (1 - hnswDistance) × min(perMemoryQuality, sharedFeedbackQuality)`
- Negative feedback categories map to quality: wrong+wrong=0.1, wrong+right=0.3, right+wrong=0.5, incomplete=0.6
- Past interactions with negative feedback include an annotation in the LLM context

### 5.6 Category Inference and Graph Cleanup

- **Filename-based inference**: 4-tier system classifies documents into 33 SA categories
- **Retroactive reassignment**: `viz-builder.js` reclassifies documents from `general` at serve time
- **Brand/category deduplication**: merges legacy brand nodes that duplicate category nodes
- **Hub suppression**: skips rendering `category:general` if it has >50 documents after inference

### 5.7 AWS Deployment Scripts

Production deployment uses four shell scripts:

| Script | Purpose | Key Operations |
|--------|---------|----------------|
| `scripts/aws-deploy.sh` | Provision EC2 Spot instance | Creates security group (22/80/443), key pair, Spot request, Elastic IP |
| `scripts/aws-setup-instance.sh` | Configure instance | Installs Docker + Caddy, clones repo, generates `.env` with random passwords, pulls from S3, starts Docker Compose, configures systemd + backup cron |
| `scripts/aws-backup.sh` | Daily database backup | `pg_dump -Fc` to S3 with configurable retention; also overwrites `dumps/grover-seed.dump` as latest seed |
| `scripts/s3-sync.sh` | S3 data distribution | `push-corpus`, `pull-corpus`, `push-seed`, `pull-seed` subcommands using `aws s3 sync`/`cp` |

Supporting config files:
- `config/grover.service` — systemd oneshot unit that runs `docker compose up -d` on boot
- `config/Caddyfile` — Caddy reverse proxy template with separate domains for Grover and Keycloak (Caddy handles Let's Encrypt TLS automatically)
- `config/01-keycloak-db.sh` — Docker entrypoint script that creates the `keycloak` database and user in PostgreSQL

Environment variables for deployment:

| Variable | Used By | Description |
|----------|---------|-------------|
| `GROVER_S3_BUCKET` | `s3-sync.sh`, `aws-setup-instance.sh` | S3 bucket for corpus and seed distribution |
| `GROVER_BACKUP_BUCKET` | `aws-backup.sh` | S3 bucket for daily backups |
| `GROVER_BACKUP_PREFIX` | `aws-backup.sh` | S3 key prefix (default: `grover-backups`) |
| `GROVER_BACKUP_RETAIN` | `aws-backup.sh` | Days to keep backups (default: 14) |
