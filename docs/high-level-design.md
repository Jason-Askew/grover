# Grover: High-Level Design

## 1. System Overview

Grover is a document search and RAG (Retrieval-Augmented Generation) system designed for multi-domain document corpora. It supports financial product documents from Westpac Group brands (Westpac, St.George, BankSA, Bank of Melbourne) and government services content from Services Australia (Centrelink, Medicare, Child Support, myGov). It combines vector embeddings, a knowledge graph, and LLM-powered Q&A to provide semantic search and natural language answers grounded in source documents.

All persistence is in PostgreSQL via the `ruvnet/ruvector-postgres` Docker image, which bundles the ruvector extension providing HNSW indexing, hybrid search, graph storage, and the `ruvector(384)` column type.

## 2. Key Capabilities

| Capability | Description |
|-----------|-------------|
| **Document Ingestion** | Extracts text from PDFs and Markdown, splits into page-aware chunks, generates ONNX vector embeddings via batch child processes, persists to PostgreSQL |
| **Knowledge Graph** | Builds a graph of brands, categories, documents, entities, and their relationships; serialized as JSONB in PostgreSQL `graphs` table |
| **Hybrid Search** | PostgreSQL HNSW approximate nearest neighbor + BM25 full-text search, fused via Reciprocal Rank Fusion (RRF), boosted by graph traversal |
| **Domain-Aware RAG** | Retrieves relevant chunks, constructs context with conversation history, generates cited answers via LLM with domain-specific system prompts |
| **Conversation Memory** | Persists Q&A history per chat in PostgreSQL (capped at 200 memories), finds relevant past interactions by HNSW embedding similarity weighted by feedback quality, rewrites follow-up queries |
| **Authentication** | Keycloak OIDC with PKCE flow, JWKS validation, PostgreSQL-backed persistent sessions, role-based access control |
| **Chat Management** | Per-user multi-chat isolation with auto-titling, rename, delete |
| **Admin Panel** | User management via Keycloak Admin REST API, token usage statistics dashboard |
| **Usage Tracking** | Per-user and per-model token counting with cost estimation, stored in PostgreSQL |
| **User Feedback** | Thumbs up/down with categorization, content-keyed quality scoring, cross-user shared feedback index |
| **Category Inference** | 4-tier filename analysis (form codes, language detection, keyword rules, medical patterns) for 100% SA category coverage |
| **Web UI** | Interactive graph visualization (vis-network) with integrated chat panel, voice interface, and graceful shutdown |
| **Multi-Index** | Isolated indexes per corpus with runtime switching and per-index memory state |

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
     │             │           │                             │
     ▼             │           ▼                     ┌───────┼────────┐
┌──────────┐       │    ┌──────────┐                 ▼       ▼        ▼
│Knowledge │       │    │  LLM /   │          ┌─────────┐ ┌──────┐ ┌──────┐
│  Graph   │       │    │   RAG    │          │  Auth   │ │Admin │ │ Chat │
└──────────┘       │    └────┬─────┘          │(Keyclk)│ │ API  │ │ Mgr  │
                   │         │                └─────────┘ └──────┘ └──────┘
                   │         ▼
                   │  ┌──────────────┐        ┌──────────┐ ┌──────────┐
                   │  │ Conversation │        │ Feedback │ │  Usage   │
                   │  │   Memory     │◄──────▶│  Index   │ │ Tracker  │
                   │  └──────────────┘        └──────────┘ └──────────┘
                   │         │                      │            │
                   ▼         ▼                      ▼            ▼
              ┌──────────────────────────────────────────────────────┐
              │                    PostgreSQL                        │
              │     ruvector-postgres (HNSW, BM25, graph storage)   │
              └──────────────────────────────────────────────────────┘
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
    ▼  Dual-path embedding
    │   • PDF-heavy or small corpora (≤500 files): in-process embedding
    │     - Load ONNX once, process all files sequentially
    │   • Large markdown-only corpora (>500 files): batch child processes
    │     - Split into batches of 500
    │     - Each batch: spawn child (--max-old-space-size=4096) → load ONNX → embed → write to disk → exit
    │     - WASM memory fully released on child exit
    │
    ▼  Parent merges all batch/in-process results
    │
    ├──▶ KnowledgeGraph.buildFromRecords()
    │       • Brand/category/document/chunk/entity nodes
    │       • Entity co-occurrence edges (cross-document)
    │       • Semantic similarity edges (cosine > 0.85)
    │
    └──▶ await saveIndex() → PostgreSQL transaction
            • INSERT INTO documents (file, mtime, url, title)
            • INSERT INTO chunks (content, embedding::ruvector, pages, ...)
            • Batch inserts: 500 rows per statement
            • Graph saved separately as JSONB in graphs table (failure won't roll back chunks)
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
    ▼  PostgreSQL hybrid search (single SQL query)
    │   • HNSW: chunks.embedding <=> query::ruvector (cosine distance)
    │   • BM25: ts_rank(chunks.tsv, plainto_tsquery(query))
    │   • Reciprocal Rank Fusion: rrf_score = 1/(60 + rank)
    │   • Fused results: SUM(rrf_score) per chunk
    │
Top-k hybrid results
    │
    ▼  KnowledgeGraph.expandResults() — 2-hop traversal
Combined results: vectorScore - (graphScore * 0.15)
    │
    ▼  ragAnswer() — format context, call LLM with domain-aware prompt + memory
Cited answer + source references

Mode labels: "hybrid+graph" | "hybrid"
```

### 4.3 Conversation Memory Flow

```
Q&A interaction
    │
    ├──▶ ConversationMemory.store()
    │       • INSERT INTO memories (query, answer, sources, embedding::ruvector)
    │       • INSERT INTO chat_messages (user + assistant)
    │       • Cap at MAX_MEMORIES (200) per chat with LRU eviction
    │
    └──▶ On next query:
            • findRelevant() — HNSW search on memories.embedding, weighted by quality
            • getRecentHistory() — last 6 messages from chat_messages table
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
            ├── Has session cookie → validate via PostgreSQL → inject user info → full UI
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
                    Server validates JWT via JWKS → creates session in PostgreSQL → sets HttpOnly cookie
                    │
                    ▼  Reload page → session cookie present → authenticated

Sessions are stored in the PostgreSQL `sessions` table. On server restart,
sessions persist automatically (no file I/O needed). A prune timer runs
every 5 minutes to clean up expired sessions.
```

**API key authentication:** When `GROVER_API_KEY` is set, external services can bypass the Keycloak OIDC flow by passing `Authorization: Bearer <key>`. The optional `X-Grover-User` header provides per-caller memory isolation. Without it, all API key calls share a default `_api` identity.

### 4.5 Chat Management Flow

```
User opens UI
    │
    ▼  ChatManager.load()
    │   • SELECT FROM chats WHERE index_name = $1 AND user_id = $2
    │   • Creates a default chat if none exist
    │   • Sets active chat from is_active flag or most recent
    │
    ├──▶ POST /api/chats → INSERT INTO chats
    ├──▶ POST /api/chats/switch → UPDATE chats SET is_active
    ├──▶ POST /api/chats/rename → UPDATE chats SET title
    ├──▶ DELETE /api/chats?id=X → DELETE FROM chats (cascades to messages + memories)
    │
    └──▶ POST /api/ask { query, chatId }
            • ChatManager routes to correct ConversationMemory
            • autoTitle() sets chat title from first query
            • touchChat() updates last_activity_at
```

### 4.6 Feedback Flow

```
User clicks thumbs up or thumbs down on an answer
    │
    ▼  POST /api/feedback { memoryId, type, category?, comment? }
    │
    ├──▶ ConversationMemory.recordFeedback()
    │       • UPDATE memories SET quality = $1, feedback = $2
    │       • Quality mapping: wrong+wrong=0.1, wrong+right=0.3, right+wrong=0.5, incomplete=0.6
    │
    └──▶ FeedbackIndex.record()
            • INSERT INTO feedback ... ON CONFLICT DO UPDATE
            • Content-keyed by hash(query + sorted source files)
            • Quality degrades to minimum across all user feedbacks
            • Shared across users — negative feedback from any user affects all
    │
    ▼  On next query:
         findRelevant() → HNSW similarity × min(per-memory quality, shared quality)
         Past answers with negative feedback get annotation: "avoid repeating same issues"
```

## 5. Key Design Decisions

### 5.1 PostgreSQL with ruvector Extension

All persistence uses PostgreSQL via the `ruvnet/ruvector-postgres` Docker image. This provides:
- **`ruvector(384)` column type** for storing 384-dimensional ONNX embeddings
- **`hnsw` index** for sub-millisecond approximate nearest neighbor search (m=16, efConstruction=200)
- **`tsvector` + GIN index** for BM25 full-text search
- **JSONB graph storage** — knowledge graphs serialized as JSONB in a `graphs` table (one row per index)
- **Transactions** for atomic index updates (full re-ingest or rollback)
- **Concurrent access safety** for multi-user web UI

This replaces the previous file-based approach (JSON files, binary Float32 arrays, RVF HNSW stores).

### 5.2 Hybrid Search with Reciprocal Rank Fusion

Search combines two retrieval strategies in a single SQL query:
1. **HNSW vector search** — cosine distance on the `ruvector(384)` embedding column
2. **BM25 full-text search** — `ts_rank` on the generated `tsvector` column

Results are fused via Reciprocal Rank Fusion (RRF): `rrf_score = 1 / (60 + rank)`. Each chunk's final score is the sum of its RRF scores from both result sets. This provides better recall than either strategy alone.

### 5.3 Knowledge Graph Augmentation

Pure vector search misses cross-document relationships. The knowledge graph adds three types of connections:
- **Entity co-occurrence**: chunks sharing financial concepts across different documents
- **Semantic similarity**: high-cosine embeddings between representative chunks of different documents
- **Structural**: brand/category hierarchies linking documents to organizational units

Graph expansion uses a combined score: `vectorScore - (graphScore * 0.15)` — the graph boost lowers the effective distance of related results.

### 5.4 ONNX Embeddings (not API-based)

Embeddings run locally via the all-MiniLM-L6-v2 ONNX model (~23MB). This means ingestion and search work entirely offline — only RAG answer generation requires an external API.

### 5.5 Dual-Path Embedding Architecture

The ONNX WASM runtime pre-allocates ~4GB of WebAssembly memory that V8 counts against the Node.js heap limit. Grover uses two strategies:

**In-process** (PDF-heavy or small corpora, ≤500 files): The ONNX model is loaded once in the main process. All files are processed sequentially. This avoids the overhead of spawning child processes that each need to reload the 4GB model. Best for Docker environments with limited memory.

**Batch child processes** (large markdown-only corpora, >500 files): Files are split into batches of 500. Each batch is processed by a short-lived child process (`embed-batch.js`) with `--max-old-space-size=4096`. The child loads ONNX, embeds all chunks, writes binary embeddings and JSON metadata to disk, then exits. On exit, the OS fully reclaims the WASM memory allocation. The parent merges all batch results.

Both paths then build the knowledge graph and save everything to PostgreSQL. For large PDF corpora that exceed Docker container memory limits, ingestion can be run locally against the PostgreSQL instance with `--max-old-space-size=8192`.

### 5.6 Domain-Aware RAG

The system prompt for RAG generation is customized per index domain. Each domain has a tailored context (e.g., Westpac = financial products and regulatory guidance; Services Australia = government payments, eligibility, and entitlements). This improves answer accuracy by grounding the LLM in the correct domain vocabulary.

### 5.7 Modular Architecture

The application is organized into a layered module structure with strict dependency rules to prevent circular imports. Each module has a single responsibility and clear public API. All persistence modules use async/await with the shared `db.query()` helper.

### 5.8 Categories-Only Ontology for Services Australia

Unlike the Westpac domain (which has 4 distinct brands), Services Australia is a single agency. Service lines (Centrelink, Medicare, Child Support, myGov) are captured as categories rather than brands, avoiding duplicate nodes in the knowledge graph. `SA_BRANDS` is an empty object.

### 5.9 Category Inference from Filenames

The SA corpus places many documents under a `general/` directory. A 4-tier inference system classifies these:
1. **Form codes** — distinctive patterns like `fa012`, `mod-pc` → `forms`
2. **Language detection** — a set of ~90 known language basenames → `translations`
3. **Keyword rules** — ~40 ordered rules from specific to general, first match wins
4. **Medical conditions** — broad regex for PBS drug pages → `pharmaceutical-benefits`

This achieves 100% category coverage across 33 SA categories. The viz builder also performs retroactive reassignment at serve time for graphs built before the inference logic was added.

### 5.10 Content-Keyed Feedback Index

Feedback is indexed by a hash of the query + sorted source files, not by memory ID. This means:
- The same question retrieving the same documents shares a quality score across users
- Negative feedback from any user degrades quality for all users
- The LLM is told when a past interaction received negative feedback, reducing repeat errors

## 6. External Dependencies

| Dependency | Purpose | Required For |
|-----------|---------|-------------|
| `ruvector` | Rust/NAPI vector DB with ONNX embedding | All operations (query-time embedding) |
| `ruvnet/ruvector-postgres` | PostgreSQL Docker image with ruvector extension (143 SQL functions) | All persistence (HNSW, hybrid search, graph storage) |
| `pg` | PostgreSQL client for Node.js | All persistence |
| `jose` | JWT verification and JWKS key set management | Authentication (lazy-loaded) |
| `@aws-sdk/client-polly` | Amazon Polly text-to-speech | Voice output (optional) |
| `cheerio` | HTML parsing | Markdown/web content processing |
| `turndown` | HTML-to-markdown conversion | Content processing |
| `pymupdf` (Python) | PDF text extraction | Ingestion only |
| OpenAI-compatible API | LLM chat completions | RAG answers only |
| Keycloak | OIDC identity provider | Authentication (optional) |

## 7. Deployment Model

Grover runs as a Docker Compose stack with three services:

1. **`postgres`** — `ruvnet/ruvector-postgres:latest` with healthcheck, persistent volume, and init script (`config/init.sql`)
2. **`keycloak`** — Keycloak 24.0 with PostgreSQL backend (same PostgreSQL instance, separate `keycloak` database)
3. **`grover`** — Node.js application, depends on postgres + keycloak healthchecks

All state is stored in PostgreSQL. The `./index` volume is only used for temporary batch files during ingestion (cleaned up after). The `./corpus` volume is read-only.

The web server supports graceful shutdown via SIGTERM/SIGINT: prunes expired sessions, closes the PostgreSQL connection pool, and handles client disconnects during SSE streaming. Debug logging is available via `GROVER_DEBUG=1`.

For local development without Docker, install PostgreSQL with the ruvector extension manually and set `DATABASE_URL` to point to it.

A `bootstrap` command is available to restore a pre-built database from a `pg_dump` seed file (`config/grover-seed.dump`). This skips ingestion entirely and populates the database in seconds: `node grover.js bootstrap` or `docker compose run --rm grover bootstrap`.

### 7.1 AWS Deployment

For production, Grover deploys to an EC2 Spot instance with Caddy reverse proxy (automatic HTTPS via Let's Encrypt) and systemd auto-start:

```
┌─────────────────────────────────────────────────────────────┐
│  EC2 Instance (Ubuntu 24.04)                                │
│                                                             │
│  ┌──────────┐     ┌──────────────────────────────────────┐  │
│  │  Caddy   │────▶│  Docker Compose                      │  │
│  │  :443    │     │  ┌──────────┐ ┌─────────┐ ┌────────┐│  │
│  │ (HTTPS)  │     │  │  Grover  │ │Keycloak │ │Postgres││  │
│  └──────────┘     │  │  :3000   │ │ :8080   │ │ :5432  ││  │
│                   │  └──────────┘ └─────────┘ └────────┘│  │
│                   └──────────────────────────────────────┘  │
│                                                             │
│  systemd: grover.service (auto-start on boot)               │
│  cron: aws-backup.sh (daily 2:00 AM UTC)                    │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   ┌───────────┐                ┌──────────────────┐
   │ Elastic IP│                │   S3 Bucket      │
   │ + DNS     │                │   corpus/        │
   └───────────┘                │   dumps/         │
                                └──────────────────┘
```

Deployment scripts:

| Script | Purpose |
|--------|---------|
| `scripts/aws-deploy.sh` | Provisions EC2 Spot instance with security group, key pair, and Elastic IP |
| `scripts/aws-setup-instance.sh` | Full instance setup: Docker, Caddy, git clone, `.env` generation, S3 pull, Docker Compose, systemd, backup cron |
| `scripts/aws-backup.sh` | Daily `pg_dump` to S3 with configurable retention; also updates latest seed dump |
| `scripts/s3-sync.sh` | Push/pull corpus files and database seed dumps to/from S3 |

Configuration files:

| File | Purpose |
|------|---------|
| `config/grover.service` | systemd unit for Docker Compose auto-start on boot |
| `config/Caddyfile` | Caddy reverse proxy template (separate domains for app and Keycloak) |
| `config/01-keycloak-db.sh` | Docker entrypoint script to create the Keycloak database in PostgreSQL |

### 7.2 S3 Data Distribution

Large binary files (PDFs, database dumps) are stored in S3 rather than git:

```
s3://$GROVER_S3_BUCKET/
  corpus/                  Source PDFs and markdown files
  dumps/
    grover-seed.dump       Latest seed (overwritten on each daily backup)
    $PREFIX/               Daily backups with retention policy
```

The `aws-setup-instance.sh` script automatically pulls corpus and seed from S3 during provisioning if `GROVER_S3_BUCKET` is set. The daily backup cron (`aws-backup.sh`) uploads each dump to the daily prefix and also overwrites the latest seed.

## 8. Operational Characteristics

| Metric | Value |
|--------|-------|
| Embedding model | all-MiniLM-L6-v2 (23MB, 384 dimensions) |
| WASM memory per batch | ~4GB (isolated in child process) |
| Batch size | 500 files per child process (batched path) or sequential (in-process path) |
| Typical ingestion | ~2,400 files → ~13,000 chunks in ~30 minutes |
| PostgreSQL storage | HNSW index + chunks table + documents table + graph |
| HNSW index parameters | m=16, efConstruction=200 (hnsw, cosine metric) |
| Memory cap | 200 conversation memories per chat with LRU eviction |
| Search | PostgreSQL HNSW + BM25 hybrid via RRF |
| Session persistence | PostgreSQL sessions table with 5-minute prune interval, survives restarts |
| SA categories | 33 categories with 100% coverage via filename inference |
| SA vocabulary | ~55 payment types, ~74 government concepts |
| Westpac vocabulary | 23 product types, 28 financial concepts, 4 brands, 4 categories |
| Docker services | 3 (postgres, keycloak, grover) |
| Reverse proxy | Caddy (automatic HTTPS via Let's Encrypt) |
| Backup | Daily pg_dump to S3 with 14-day retention |
| S3 sync | Corpus and seed dump distribution via `scripts/s3-sync.sh` |

## 9. PostgreSQL Schema Overview

All tables are defined in `config/init.sql`:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `documents` | One row per ingested file | `index_name`, `file`, `mtime`, `url`, `title` |
| `chunks` | One row per text chunk | `embedding ruvector(384)` + HNSW index, `tsv tsvector` + GIN index |
| `sessions` | Server-side auth sessions | `user_id`, `email`, `roles`, `created_at`, `ttl` |
| `chats` | Per-user chat metadata | `index_name`, `user_id`, `title`, `is_active` |
| `chat_messages` | Chat message history | `chat_id`, `role`, `content`, `sources`, `memory_id` |
| `memories` | Conversation memories | `embedding ruvector(384)` + HNSW index, `quality`, `feedback` |
| `graphs` | Knowledge graph per index (JSONB) | `index_name`, `data` (JSONB), `node_count`, `edge_count` |
| `feedback` | Cross-user content quality | `content_key`, `quality`, `feedbacks` (JSONB) |
| `usage_stats` | LLM token usage | `user_id`, `model`, `prompt_tokens`, `completion_tokens`, `cost` |

Knowledge graphs are serialized as JSONB in the `graphs` table (one row per index, keyed by `index_name`).
