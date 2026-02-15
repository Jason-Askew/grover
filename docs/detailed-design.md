# Grover: Detailed Design

## 1. Module Architecture

### 1.1 Directory Structure

```
search.js                          CLI dispatcher (53 lines)
src/
├── config.js                      File paths, env vars, LLM config
├── domain-constants.js            Financial domain vocabulary
├── utils/
│   ├── math.js                    Shared cosine similarity
│   ├── pdf.js                     PDF text extraction + page-aware chunking
│   ├── file-discovery.js          Recursive PDF file finder
│   └── formatting.js              Result + context formatters
├── graph/
│   ├── entity-extraction.js       Domain entity + document metadata extraction
│   └── knowledge-graph.js         KnowledgeGraph class (nodes, edges, traversal)
├── memory/
│   └── conversation-memory.js     ConversationMemory class (persist, recall, SONA)
├── persistence/
│   └── index-persistence.js       Binary embedding + JSON metadata save/load
├── retrieval/
│   ├── vector-search.js           Brute-force cosine distance search
│   └── retrieve.js                Orchestrates search pipeline (embed → vector → graph)
├── llm/
│   ├── client.js                  OpenAI-compatible HTTP client (streaming + non-streaming)
│   ├── query-rewrite.js           Follow-up query expansion via LLM
│   └── rag.js                     RAG answer generation with memory integration
├── server/
│   ├── viz-builder.js             Graph-to-visualization data transformer
│   └── chat-panel.html            Injected chat panel (HTML/CSS/JS)
└── commands/
    ├── ingest.js                  Full PDF ingestion pipeline
    ├── update.js                  Incremental index update (add/modify/delete)
    ├── search.js                  CLI search command
    ├── ask.js                     Single-query RAG command
    ├── interactive.js             REPL mode with full command set
    ├── serve.js                   HTTP server with graph viz + chat
    └── stats.js                   Index statistics reporter
```

### 1.2 Dependency Graph

Dependencies flow strictly downward. No circular imports exist.

```
Layer 0: config.js, domain-constants.js
    ▲
Layer 1: utils/math, utils/pdf, utils/file-discovery, utils/formatting
    ▲
Layer 2: graph/entity-extraction, graph/knowledge-graph, memory/conversation-memory
    ▲
Layer 3: persistence/index-persistence, retrieval/vector-search,
         llm/client, llm/query-rewrite, llm/rag, retrieval/retrieve
    ▲
Layer 4: commands/*, server/viz-builder
```

**Rules enforced:**
- `utils/` and constants depend on nothing in `src/`
- `graph/` and `memory/` depend only on Layer 0-1
- `persistence/` depends on `graph/` (for `KnowledgeGraph.fromJSON`)
- `llm/` depends on config + `utils/formatting` only
- `retrieval/` depends on `llm/query-rewrite` + `retrieval/vector-search`
- `commands/` depend on everything above, never on each other (except `update` imports `ingest` as fallback)

---

## 2. Module Specifications

### 2.1 `src/config.js`

Centralizes all file paths and environment variable reading.

| Export | Type | Description |
|--------|------|-------------|
| `DOCS_DIR` | `string` | Source PDF directory (`./corpus`) |
| `INDEX_DIR` | `string` | Generated index directory (`./index`) |
| `META_FILE` | `string` | `./index/metadata.json` |
| `EMBEDDINGS_FILE` | `string` | `./index/embeddings.bin` |
| `GRAPH_FILE` | `string` | `./index/graph.json` |
| `MEMORY_FILE` | `string` | `./index/memory.json` |
| `LLM_API_KEY` | `string` | `OPENAI_API_KEY` env var |
| `LLM_BASE_URL` | `string` | `OPENAI_BASE_URL` env var (default: OpenAI) |
| `LLM_MODEL` | `string` | `LLM_MODEL` env var (default: `gpt-4o-mini`) |

### 2.2 `src/domain-constants.js`

Financial domain vocabulary used for entity extraction.

| Export | Type | Count | Examples |
|--------|------|-------|---------|
| `PRODUCT_TYPES` | `string[]` | 22 | forward contract, fx swap, term deposit |
| `FINANCIAL_CONCEPTS` | `string[]` | 33 | margin call, settlement, hedging, break costs |
| `BRANDS` | `Object` | 4 | `{ wbc: 'Westpac', sgb: 'St.George Bank', ... }` |
| `CATEGORIES` | `Object` | 4 | `{ fx: 'Foreign Exchange', irrm: 'Interest Rate Risk Management', ... }` |

### 2.3 `src/utils/math.js`

Single shared implementation of cosine similarity, eliminating the duplication that previously existed between `ConversationMemory.findRelevant` and the standalone `cosineSim` function.

```
cosineSim(a: Float32Array, b: Float32Array) → number
```

Returns the cosine similarity in the range [-1, 1]. Uses epsilon `1e-8` to avoid division by zero.

### 2.4 `src/utils/pdf.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractPdfText` | `(filePath: string) → { numPages, pages[] }` | Invokes Python/pymupdf via `child_process.execSync`. Returns per-page text. Max buffer: 50MB. |
| `chunkPages` | `(pages[], maxChars?, overlap?) → chunk[]` | Page-aware text chunking. Default 1000 chars with 200-char overlap. Breaks at paragraph > newline > sentence boundaries. Minimum chunk size: 20 chars. Returns `{ text, pageStart, pageEnd }`. |

### 2.5 `src/utils/file-discovery.js`

```
findPdfs(dir: string) → string[]
```

Recursively finds all `.pdf` files under `dir`, skipping hidden directories (`.`-prefixed). Returns absolute paths.

### 2.6 `src/utils/formatting.js`

| Function | Purpose | Used By |
|----------|---------|--------|
| `formatResult(r, i, showGraph?)` | Formats a single search result for CLI display. Shows score, file, page range, graph tags, boost. | `commands/search`, `commands/interactive` |
| `formatContext(results)` | Formats results as numbered `[Source N]` blocks for LLM context. | `llm/rag` |

### 2.7 `src/graph/entity-extraction.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractEntities` | `(text: string) → string[]` | Case-insensitive substring matching against `PRODUCT_TYPES` and `FINANCIAL_CONCEPTS`. Returns prefixed IDs: `product:forward contract`, `concept:margin call`. |
| `extractDocMeta` | `(filePath: string) → { brand, brandName, category, categoryName }` | Extracts brand and category from file path segments by matching against `BRANDS` and `CATEGORIES` keys. |

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
| `expandResults(vectorResults, allRecords, k)` | Graph-enhanced search. For each vector result, traverses 2 hops to find related chunks. Returns combined results scored as `vectorScore - (graphScore * 0.15)` plus a traversal path for visualization. |
| `getNeighbors(id, edgeType?, maxDepth?)` | Depth-limited BFS traversal. Returns `{id, type, weight, depth}` for each neighbor. |
| `toJSON()` / `fromJSON(data)` | Serialization via Map-to-array conversion. |

### 2.9 `src/memory/conversation-memory.js`

The `ConversationMemory` class (117 lines) provides persistent Q&A memory.

**Storage:**
- `memories[]` — Full Q&A records with embeddings, stored as JSON arrays in `memory.json`
- `history[]` — Last 100 role/content messages for LLM context window
- `ReasoningBank` — In-memory embedding store (rebuilt on load from persisted embeddings)
- `SonaCoordinator` — Trajectory recording for pattern learning

**Methods:**

| Method | Description |
|--------|-------------|
| `load()` | Reads `memory.json`, rebuilds ReasoningBank from stored embeddings. Idempotent (skips if already loaded). |
| `save()` | Writes current state to `memory.json`. Converts Float32Arrays to regular arrays. |
| `store(query, answer, sources, queryEmbedding)` | Stores a new Q&A interaction. Records SONA trajectory with retrieval and generation steps. Auto-saves. |
| `findRelevant(queryEmbedding, k?)` | Returns top-k past interactions with cosine similarity > 0.5. Uses shared `cosineSim` from `utils/math`. |
| `getRecentHistory(n?)` | Returns last `n` messages from conversation history. |
| `stats()` | Returns memory and SONA statistics. |

### 2.10 `src/persistence/index-persistence.js`

| Function | Description |
|----------|-------------|
| `saveIndex(records, dim, graph)` | Writes metadata as JSON, embeddings as raw Float32 binary, graph as JSON. Creates `./index/` if needed. |
| `loadIndex()` | Reads metadata + binary embeddings, reconstructs Float32Arrays, deserializes graph via `KnowledgeGraph.fromJSON`. Returns `{ dim, records, graph }` or `null`. |

**Binary format:** Embeddings are stored as a flat `Float32LE` buffer. Record `i`, dimension `j` is at byte offset `(i * dim + j) * 4`. For 6,220 records at 384 dimensions, this produces a ~9.1 MB file.

### 2.11 `src/retrieval/vector-search.js`

```
vectorSearch(queryVec: Float32Array, records: Object[], k: number) → [{id, score, record}]
```

Brute-force cosine distance search. Computes query norm once, then iterates all records. Returns top-k results sorted by ascending distance (lower = more similar). Uses `Float64Array` for scored distances to avoid precision loss.

### 2.12 `src/retrieval/retrieve.js`

```
retrieve(query, index, { k?, graphMode?, memory? }) → { results, path, mode }
```

Orchestrates the full retrieval pipeline:
1. Rewrites query if follow-up detected (via `rewriteQuery`)
2. Embeds query via ONNX
3. Runs `vectorSearch` (over-fetches to `max(k, 10)` if graph mode active)
4. If graph available, runs `expandResults` for graph-boosted ranking
5. Returns results, graph traversal path (for viz), and mode label

### 2.13 `src/llm/client.js`

```
callLLM(messages, { stream? }) → string
```

Sends chat completion request to OpenAI-compatible API. In streaming mode, writes tokens to stdout in real-time and returns the full response. In non-streaming mode, returns the response body directly. Parameters: temperature 0.2, max_tokens 2048.

### 2.14 `src/llm/query-rewrite.js`

```
rewriteQuery(query, memory) → string
```

Detects follow-up queries (short queries or those starting with referential language like "what about", "same for", etc.) and rewrites them into standalone search queries using the LLM. Returns the original query unchanged if no rewrite is needed.

### 2.15 `src/llm/rag.js`

```
ragAnswer(query, results, memory?, { stream? }) → { answer, sources }
```

Central RAG function used by both CLI and web server. Key design: the `{ stream }` option eliminates what was previously duplicated logic between the `ask` command and the `serve` command's `/api/ask` handler.

| `stream` | Behavior |
|----------|----------|
| `true` (default) | Prints sources summary, past interactions, and LLM tokens to stdout. Used by CLI commands. |
| `false` | Silent operation. Returns `{ answer, sources }` for JSON API responses. Used by web server. |

Both modes store the interaction in memory and return the same `{ answer, sources }` structure.

### 2.16 `src/server/viz-builder.js`

```
buildVizData(graph) → { nodes[], edges[] }
```

Transforms the internal knowledge graph into a visualization-friendly format:
- Excludes chunk nodes (too numerous for visualization)
- Collapses chunk-to-entity edges to document-to-entity edges
- Limits entity mention edges to top 3 per entity by accumulated weight
- Prunes orphan entity/concept nodes with no edges
- Adds `chunkCount` to document nodes and `degree` to entity nodes

### 2.17 `src/server/chat-panel.html`

A self-contained HTML fragment (265 lines) containing CSS styles, HTML markup, and JavaScript for the chat panel. Injected into `graph-viz.html` at serve time via string replacement. Features:
- Message rendering with markdown-like formatting
- Source citation click-to-focus (delegates to graph-viz.html's `focusNode`)
- Graph path highlighting on query response
- Memory clear via `/api/forget`

### 2.18 Command Modules (`src/commands/`)

| Command | Lines | Description |
|---------|-------|-------------|
| `ingest.js` | 71 | Full scan of `./corpus`, extracts text, chunks, embeds, builds graph, saves index |
| `update.js` | 106 | Incremental: detects new/modified/deleted PDFs by mtime, processes only changes, rebuilds graph |
| `search.js` | 20 | Loads index, calls `retrieve`, prints formatted results |
| `ask.js` | 27 | Loads index + memory, calls `retrieve` + `ragAnswer` with streaming |
| `interactive.js` | 184 | Full REPL with flags (`--flat`, `--k N`, `--search`, `--related`, `--entities`, `--memory`, `--forget`) |
| `serve.js` | 144 | HTTP server. Injects graph data + chat panel into HTML. `/api/ask` uses `ragAnswer({stream: false})`. `/api/forget` clears memory. |
| `stats.js` | 65 | Reads index/graph/memory and prints statistics |

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

### 3.4 `memory.json`

```json
{
  "history": [
    {"role": "user", "content": "...", "timestamp": "2025-01-01T00:00:00.000Z"},
    {"role": "assistant", "content": "...", "timestamp": "2025-01-01T00:00:00.000Z"}
  ],
  "memories": [
    {
      "id": "mem-1700000000000",
      "query": "What is a forward contract?",
      "answer": "A forward contract is...",
      "sources": [{"file": "...", "pageStart": 1, "pageEnd": 2, "score": 0.85}],
      "embedding": [0.1, 0.2, ...],
      "timestamp": "2025-01-01T00:00:00.000Z",
      "quality": 1.0
    }
  ]
}
```

### 3.5 `/api/ask` Response

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
  "mode": "vector+graph"
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

---

## 5. Refactoring Decisions

### 5.1 Eliminated Duplications

| Duplication | Before | After |
|------------|--------|-------|
| Cosine similarity | Inline in `ConversationMemory.findRelevant` (6 lines) + standalone `cosineSim` (8 lines) | Single `cosineSim` in `utils/math.js`, imported by both |
| RAG logic in serve | `/api/ask` handler duplicated ~25 lines of context-building, LLM calling, and memory storing from `ragAnswer` | `ragAnswer(query, results, memory, { stream: false })` — one call, returns `{ answer, sources }` |
| Chat panel HTML | 265-line template string embedded in JS | Separate `chat-panel.html` file, loaded with `fs.readFileSync` |

### 5.2 Module Size Distribution

No module exceeds 303 lines (the KnowledgeGraph class, which is a single cohesive class). Most modules are under 100 lines:

| Range | Count | Modules |
|-------|-------|---------|
| 10-20 lines | 4 | math, config, file-discovery, search cmd |
| 20-50 lines | 5 | domain-constants, formatting, entity-extraction, retrieve, ask cmd |
| 50-120 lines | 7 | pdf, client, query-rewrite, rag, ingest, stats, conversation-memory |
| 100-200 lines | 3 | update, serve, interactive |
| 200-310 lines | 1 | knowledge-graph |
