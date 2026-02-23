# Grover: High-Level Design

## 1. System Overview

Grover is a document search and RAG (Retrieval-Augmented Generation) system designed for multi-domain document corpora. It supports financial product documents from Westpac Group brands (Westpac, St.George, BankSA, Bank of Melbourne) and government services content from Services Australia (Centrelink, Medicare, Child Support, myGov). It combines vector embeddings, a knowledge graph, and LLM-powered Q&A to provide semantic search and natural language answers grounded in source documents.

## 2. Key Capabilities

| Capability | Description |
|-----------|-------------|
| **Document Ingestion** | Extracts text from PDFs and Markdown, splits into page-aware chunks, generates ONNX vector embeddings via batch child processes |
| **Knowledge Graph** | Builds an in-memory graph of brands, categories, documents, entities, and their relationships |
| **Semantic Search** | Brute-force cosine distance search over 384-dimensional embeddings, boosted by graph traversal |
| **Domain-Aware RAG** | Retrieves relevant chunks, constructs context with conversation history, generates cited answers via LLM with domain-specific system prompts |
| **Conversation Memory** | Persists Q&A history per chat (capped at 200 memories), finds relevant past interactions by embedding similarity weighted by feedback quality, rewrites follow-up queries |
| **Authentication** | Keycloak OIDC with PKCE flow, JWKS validation, server-side sessions, role-based access control |
| **Chat Management** | Per-user multi-chat isolation with auto-titling, rename, delete, and legacy migration |
| **Admin Panel** | User management via Keycloak Admin REST API, token usage statistics dashboard |
| **Usage Tracking** | Per-user and per-model token counting with cost estimation, persisted to disk |
| **User Feedback** | Thumbs up/down with categorization, content-keyed quality scoring, cross-user shared feedback index, SONA trajectory integration |
| **Category Inference** | 4-tier filename analysis (form codes, language detection, keyword rules, medical patterns) for 100% SA category coverage |
| **Web UI** | Interactive graph visualization (vis-network) with integrated chat panel, voice interface, and graceful shutdown |
| **Multi-Index** | Isolated indexes per corpus with runtime switching and per-index memory/learning state |

## 3. Architecture Diagram

```
                           ┌─────────────────────────────┐
                           │      CLI Dispatcher          │
                           │        grover.js             │
                           └──────────┬──────────────────-┘
                                      │
              ┌───────────┬───────────┼───────────┬──────────────┐
              ▼           ▼           ▼           ▼              ▼
        ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────┐  ┌──────────┐
        │  ingest  │ │  search  │ │  ask   │ │interact│  │  serve   │
        │  update  │ │          │ │        │ │  ive   │  │          │
        └────┬─────┘ └────┬─────┘ └───┬────┘ └───┬────┘  └────┬─────┘
             │            │           │           │            │
    ┌────────┴──────┐     └─────┬─────┘     ┌─────┘            │
    │               │           │           │                  │
    ▼               ▼           ▼           │                  ▼
┌────────┐   ┌──────────┐ ┌──────────┐     │          ┌──────────────┐
│  PDF   │   │  Index   │ │Retrieval │◄────┘          │  HTTP Server │
│Extract │   │Persist.  │ │ Pipeline │                │  + Chat UI   │
└────┬───┘   └──────────┘ └────┬─────┘                └──────┬───────┘
     │                         │                             │
     ▼                         ▼                     ┌───────┼────────┐
┌──────────┐            ┌──────────┐                 ▼       ▼        ▼
│Knowledge │            │  LLM /   │          ┌─────────┐ ┌──────┐ ┌──────┐
│  Graph   │            │   RAG    │          │  Auth   │ │Admin │ │ Chat │
└──────────┘            └────┬─────┘          │(Keyclk)│ │ API  │ │ Mgr  │
                             │                └─────────┘ └──────┘ └──────┘
                             ▼
                      ┌──────────────┐        ┌──────────┐ ┌──────────┐
                      │ Conversation │        │ Feedback │ │  Usage   │
                      │   Memory     │◄──────▶│  Index   │ │ Tracker  │
                      └──────────────┘        └──────────┘ └──────────┘
```

## 4. Data Flow

### 4.1 Ingestion Pipeline

```
PDFs + Markdown in ./corpus/
    │
    ├──▶ PDF: Python (pymupdf) page-level text extraction
    └──▶ Markdown: YAML front-matter parsing (title, url, source)
    │
    ▼  chunkPages() / chunkText()
Page-aware chunks (1000 char, 200 overlap)
    │
    ▼  Batch child process architecture
    │   • Files split into batches of 500
    │   • Each batch: spawn child → load ONNX → embed → write to disk → exit
    │   • Child uses --max-old-space-size=6144 to accommodate WASM
    │   • WASM memory fully released on child exit
    │
    ▼  embed-batch.js worker (per batch)
    │   • Loads ONNX model (all-MiniLM-L6-v2, 384d)
    │   • Streams embeddings to .emb binary file
    │   • Writes chunk metadata to .json file
    │
    ▼  Parent merges all batch results
    │
    ├──▶ KnowledgeGraph.buildFromRecords()
    │       • Brand/category/document/chunk/entity nodes
    │       • Entity co-occurrence edges (cross-document)
    │       • Semantic similarity edges (cosine > 0.85)
    │
    └──▶ saveIndex()
            • embeddings.bin  (Float32, ~19 MB for 13,000+ chunks)
            • metadata.json   (chunk text, file paths, page ranges)
            • graph.json      (serialized graph)
```

### 4.2 Retrieval Pipeline

```
User query
    │
    ▼  rewriteQuery() — if follow-up, rewrite via LLM
Standalone search query
    │
    ▼  ruvector ONNX embed
384d query vector
    │
    ▼  vectorSearch() — brute-force cosine distance
Top-k vector results (sorted by distance, lower = better)
    │
    ▼  KnowledgeGraph.expandResults() — 2-hop traversal
Combined results: vectorScore - (graphScore * 0.15)
    │
    ▼  ragAnswer() — format context, call LLM with domain-aware prompt + memory
Cited answer + source references
```

### 4.3 Conversation Memory Flow

```
Q&A interaction
    │
    ├──▶ ConversationMemory.store()
    │       • Embed query → store in ReasoningBank
    │       • Record trajectory in SONA coordinator
    │       • Persist to per-chat memory file (last 100 messages)
    │
    └──▶ On next query:
            • findRelevant() — cosine similarity × quality score against past queries
            • getRecentHistory() — last 6 messages for LLM context
            • rewriteQuery() — expand follow-ups into standalone queries
            • Negative feedback annotations surfaced to LLM
```

### 4.4 Authentication Flow

```
Browser → GET /
    │
    ├── No KEYCLOAK_URL → anonymous access, full UI
    │
    └── KEYCLOAK_URL set:
            │
            ├── Has session cookie → validate → inject user info → full UI
            │
            └── No session → show login overlay
                    │
                    ▼  PKCE OIDC flow
                    Browser generates code_verifier, redirects to Keycloak /auth
                    │
                    ▼  User authenticates at Keycloak
                    Keycloak redirects to /auth/callback with authorization code
                    │
                    ▼  Browser exchanges code for tokens at Keycloak /token
                    │
                    ▼  POST /api/auth/session { id_token }
                    Server validates JWT via JWKS → creates session → sets HttpOnly cookie
                    │
                    ▼  Reload page → session cookie present → authenticated
```

### 4.5 Chat Management Flow

```
User opens UI
    │
    ▼  ChatManager.load()
    │   • Loads chats.json metadata (per-user directory)
    │   • Migrates legacy memory.json if no chats exist
    │   • Ensures at least one chat always exists
    │
    ├──▶ POST /api/chats → create new chat
    ├──▶ POST /api/chats/switch → switch active chat
    ├──▶ POST /api/chats/rename → rename chat
    ├──▶ DELETE /api/chats?id=X → delete chat + memory file
    │
    └──▶ POST /api/ask { query, chatId }
            • ChatManager routes to correct memory file
            • autoTitle() sets chat title from first query
            • touchChat() updates lastActivityAt
```

### 4.6 Feedback Flow

```
User clicks 👍 or 👎 on an answer
    │
    ▼  POST /api/feedback { memoryId, type, category?, comment? }
    │
    ├──▶ ConversationMemory.recordFeedback()
    │       • Updates quality score on the memory entry
    │       • Records feedback trajectory in SONA
    │       • Quality mapping: wrong+wrong=0.1, wrong+right=0.3, right+wrong=0.5, incomplete=0.6
    │
    └──▶ FeedbackIndex.record()
            • Content-keyed by hash(query + sorted source files)
            • Quality degrades to minimum across all user feedbacks
            • Shared across users — negative feedback from any user affects all
    │
    ▼  On next query:
         findRelevant() → similarity × min(per-memory quality, shared quality)
         Past answers with negative feedback get annotation: "avoid repeating same issues"
```

## 5. Key Design Decisions

### 5.1 Brute-Force Vector Search (not ANN)

At 384 dimensions x 6,220 records, brute-force cosine distance takes <50ms in pure JS. This avoids the overhead of building and maintaining an approximate nearest neighbor index while providing exact results.

### 5.2 Knowledge Graph Augmentation

Pure vector search misses cross-document relationships. The knowledge graph adds three types of connections:
- **Entity co-occurrence**: chunks sharing financial concepts across different documents
- **Semantic similarity**: high-cosine embeddings between representative chunks of different documents
- **Structural**: brand/category hierarchies linking documents to organizational units

Graph expansion uses a combined score: `vectorScore - (graphScore * 0.15)` — the graph boost lowers the effective distance of related results.

### 5.3 ONNX Embeddings (not API-based)

Embeddings run locally via the all-MiniLM-L6-v2 ONNX model (~23MB). This means ingestion and search work entirely offline — only RAG answer generation requires an external API.

### 5.4 Batch Child Process Architecture

The ONNX WASM runtime pre-allocates ~4GB of WebAssembly memory that V8 counts against the Node.js heap limit. To support large corpora without OOM, ingestion uses a batch child process model:

- Files are split into batches of 500
- Each batch is processed by a short-lived child process (`embed-batch.js`)
- The child loads ONNX, embeds all chunks, writes binary embeddings and JSON metadata to disk, then exits
- On exit, the OS fully reclaims the WASM memory allocation
- The parent (which never loads ONNX) merges all batch results, builds the knowledge graph, and saves the index

This ensures bounded, predictable memory usage regardless of corpus size.

### 5.5 Domain-Aware RAG

The system prompt for RAG generation is customized per index domain. Each domain has a tailored context (e.g., Westpac = financial products and regulatory guidance; Services Australia = government payments, eligibility, and entitlements). This improves answer accuracy by grounding the LLM in the correct domain vocabulary.

### 5.6 Modular Architecture

The application is organized into a layered module structure with strict dependency rules to prevent circular imports. Each module has a single responsibility and clear public API.

### 5.7 Categories-Only Ontology for Services Australia

Unlike the Westpac domain (which has 4 distinct brands), Services Australia is a single agency. Service lines (Centrelink, Medicare, Child Support, myGov) are captured as categories rather than brands, avoiding duplicate nodes in the knowledge graph. `SA_BRANDS` is an empty object.

### 5.8 Category Inference from Filenames

The SA corpus places many documents under a `general/` directory. A 4-tier inference system classifies these:
1. **Form codes** — distinctive patterns like `fa012`, `mod-pc` → `forms`
2. **Language detection** — a set of ~90 known language basenames → `translations`
3. **Keyword rules** — ~40 ordered rules from specific to general, first match wins
4. **Medical conditions** — broad regex for PBS drug pages → `pharmaceutical-benefits`

This achieves 100% category coverage across 33 SA categories. The viz builder also performs retroactive reassignment at serve time for graphs built before the inference logic was added.

### 5.9 Content-Keyed Feedback Index

Feedback is indexed by a hash of the query + sorted source files, not by memory ID. This means:
- The same question retrieving the same documents shares a quality score across users
- Negative feedback from any user degrades quality for all users
- The LLM is told when a past interaction received negative feedback, reducing repeat errors

## 6. External Dependencies

| Dependency | Purpose | Required For |
|-----------|---------|-------------|
| `ruvector` | Rust/NAPI vector DB with ONNX embedding | All operations |
| `@ruvector/ruvllm` | ReasoningBank, SONA coordinator, trajectories | Conversation memory |
| `jose` | JWT verification and JWKS key set management | Authentication (lazy-loaded) |
| `@aws-sdk/client-polly` | Amazon Polly text-to-speech | Voice output (optional) |
| `pymupdf` (Python) | PDF text extraction | Ingestion only |
| OpenAI-compatible API | LLM chat completions | RAG answers only |
| Keycloak | OIDC identity provider | Authentication (optional) |

## 7. Deployment Model

Grover runs as a single-process Node.js application for search and serving. Ingestion spawns short-lived child processes for embedding but is otherwise self-contained. There is no database server, message queue, or container orchestration — all state is stored in flat files under `./index/`. This makes it suitable for local or small-team use on a single machine.

A `docker-compose.yml` is provided for running Keycloak locally for development. In production, Keycloak should be deployed separately.

The web server supports graceful shutdown via SIGTERM/SIGINT and handles client disconnects during SSE streaming. Debug logging is available via `GROVER_DEBUG=1`.

## 8. Operational Characteristics

| Metric | Value |
|--------|-------|
| Embedding model | all-MiniLM-L6-v2 (23MB, 384 dimensions) |
| WASM memory per batch | ~4GB (isolated in child process) |
| Batch size | 500 files per child process |
| Typical ingestion | ~2,400 files → ~13,000 chunks in ~30 minutes |
| Index size | ~20MB embeddings + ~20MB metadata + ~18MB graph |
| Memory cap | 200 conversation memories per chat with LRU eviction |
| Search latency | <50ms for brute-force cosine over 13,000 chunks |
| SA categories | 33 categories with 100% coverage via filename inference |
| SA vocabulary | ~55 payment types, ~74 government concepts |
| Westpac vocabulary | 23 product types, 28 financial concepts, 4 brands, 4 categories |
