# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Grover is a document search and RAG (Retrieval-Augmented Generation) system designed for multi-domain document corpora. It supports financial product documents from Westpac Group brands (Westpac/WBC, St.George/SGB, BankSA/BSA, Bank of Melbourne/BOM) and government services content from Services Australia (Centrelink, Medicare, Child Support, myGov). It ingests PDFs and Markdown, builds ONNX vector embeddings + a knowledge graph, and supports semantic search, LLM-powered Q&A, and a web UI with graph visualization, authentication, multi-chat management, and an admin panel.

The application entry point is `grover.js` (thin CLI dispatcher) with modular source code under `src/` (CommonJS).

## Commands

```bash
# Ingest PDFs from ./corpus into vector index + knowledge graph
node grover.js ingest

# Incremental update (new/modified/deleted PDFs only)
node grover.js update

# Vector + graph search
node grover.js search "query text"

# RAG Q&A (requires OPENAI_API_KEY)
node grover.js ask "question"

# Interactive REPL (RAG if LLM configured, else search-only)
node grover.js interactive   # or: node grover.js i

# Web UI with graph visualization + chat panel (default port 3000)
node grover.js serve          # or: node grover.js web
node grover.js serve 8080     # custom port

# Index statistics
node grover.js stats
```

### Docker

```bash
# Copy and edit env file
cp .env.example .env

# Build and run (Grover + PostgreSQL + Keycloak)
docker compose up --build

# Run detached
docker compose up --build -d
docker compose logs -f        # watch logs

# Run a specific command in the container
docker compose run grover ingest --index MyCorpus

# Health check
curl http://localhost:3000/health

# Inspect PostgreSQL
docker compose exec postgres psql -U grover -d grover -c '\dt'
docker compose exec postgres psql -U grover -d grover -c "SELECT count(*) FROM chunks"
```

The Docker image uses Node 22 (bookworm-slim) with Python 3 + pymupdf. Docker Compose runs three services: `postgres` (ruvector-postgres with HNSW + graph extensions), `keycloak` (OIDC auth on PostgreSQL), and `grover` (the app). All persistence is in PostgreSQL; the `./index` volume is only used for batch temp files during ingest.

There is no build step, no linter, and no test suite configured.

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (default: `postgres://grover:grover@localhost:5432/grover`)
- `POSTGRES_PASSWORD` — PostgreSQL password (default: `grover`)
- `OPENAI_API_KEY` — Required for RAG (`ask`, `interactive`, `serve`). Any OpenAI-compatible API works.
- `OPENAI_BASE_URL` — Override API endpoint (default: `https://api.openai.com/v1`)
- `LLM_MODEL` — Override model (default: `gpt-4o-mini`)
- `KEYCLOAK_URL` — Keycloak server URL (enables OIDC authentication when set)
- `KEYCLOAK_PUBLIC_URL` — Browser-facing Keycloak URL (defaults to `KEYCLOAK_URL`; in Docker, set to `http://localhost:8080` while `KEYCLOAK_URL` uses the internal service name)
- `KEYCLOAK_REALM` — Keycloak realm name (default: `grover`)
- `KEYCLOAK_CLIENT_ID` — Keycloak client ID (default: `grover-web`)
- `AUTH_SESSION_TTL` — Session TTL in ms (default: `86400000` / 24h)
- `CORS_ORIGIN` — Override CORS allowed origin (default: `http://localhost:<port>`)

## Architecture

### Data Flow

1. **Ingest**: PDFs in `./corpus` → Python (`pymupdf`) text extraction → page-aware chunking (1000 char, 200 overlap) → ONNX embeddings via `ruvector` → knowledge graph construction → persisted to PostgreSQL (documents, chunks with ruvector(384) embeddings, HNSW index, ruvector graph)
2. **Search**: Query → ONNX embedding → PostgreSQL hybrid search (HNSW vector + BM25 full-text, fused via Reciprocal Rank Fusion) → knowledge graph expansion → ranked results
3. **RAG**: Search results → formatted context + conversation memory (HNSW search on memories table) → OpenAI-compatible chat completion → answer with source citations

### Key Dependencies

- **`ruvector`** — Rust/NAPI vector database with ONNX embedding support. Used for `rv.initOnnxEmbedder()` and `rv.embed()` (query-time embedding in Node.js).
- **`ruvnet/ruvector-postgres`** — PostgreSQL image with ruvector extension (143 SQL functions). Provides HNSW indexing (`ruhnsw`), hybrid search, graph storage (`ruvector_create_graph`, `ruvector_add_node`, `ruvector_add_edge`), and the `ruvector(384)` column type.
- **`pg`** — PostgreSQL client for Node.js. Connection pool in `src/persistence/db.js`.
- **`pymupdf`** (Python) — PDF text extraction, invoked via `child_process.execSync`. Python 3 with pymupdf must be installed.
- **`jose`** — JWT/JWKS validation for Keycloak OIDC authentication.
- **`@aws-sdk/client-polly`** — Amazon Polly text-to-speech.

### PostgreSQL Schema

All persistence is in PostgreSQL (no JSON files). Key tables:
- **`documents`** — One row per ingested file (file path, mtime, URL, title)
- **`chunks`** — One row per text chunk with `ruvector(384)` embedding column + `ruhnsw` HNSW index + `tsvector` GIN index for BM25
- **`sessions`** — Server-side auth sessions (replaces sessions.json)
- **`chats`** — Per-user chat metadata (replaces chats.json)
- **`chat_messages`** — Chat history (replaces per-chat JSON files)
- **`memories`** — Conversation memories with `ruvector(384)` embedding for HNSW similarity search
- **`feedback`** — Cross-user content quality signals (replaces feedback-index.json)
- **`usage_stats`** — LLM token usage tracking (replaces usage-stats.json)

Schema defined in `config/init.sql`. Knowledge graph stored via ruvector graph functions per index.

### Knowledge Graph

The `KnowledgeGraph` class builds an in-memory graph during ingest with these node types:
- **brand** — WBC, SGB, BSA, BOM (Westpac domain only; SA uses categories-only, no brands)
- **category** — FX, IRRM, Deposits, Loans (Westpac); 31 categories for SA including Centrelink, Medicare, Child Support, etc.
- **document** — One per PDF file
- **chunk** — One per text chunk
- **product/concept** — Extracted entities (forward contracts, margin calls, JobSeeker, income test, etc.)

Edges encode: `part_of`, `contains`, `belongs_to_brand`, `in_category`, `mentions`, `shared_concept`, `semantically_similar`. The graph is persisted to PostgreSQL via ruvector graph functions and loaded back for query-time graph expansion.

### Conversation Memory

`ConversationMemory` persists Q&A history per chat in PostgreSQL (`memories` + `chat_messages` tables). Memory embeddings are stored as `ruvector(384)` columns with HNSW indexing for fast similarity search. Follow-up queries are rewritten into standalone searches via LLM when they appear referential. `ChatManager` provides per-user multi-chat isolation with auto-titling.

### File Layout

```
grover.js              — CLI dispatcher (delegates to src/commands/)
src/                   — Modular source code (config, utils, graph, memory, llm, retrieval, commands, server)
src/persistence/db.js  — PostgreSQL connection pool (singleton)
graph-viz.html         — vis-network graph visualization template (served by web UI)
corpus/                — Source PDFs organized by brand/category
docs/                  — System documentation (design docs)
index/                 — Temp files during ingest only (batch_*.json, batch_*.emb)
config/init.sql        — PostgreSQL schema (runs on first docker compose up)
config/keycloak/       — Keycloak realm import
Dockerfile             — Multi-stage Docker build (Node 22 + Python 3 + pymupdf)
docker-compose.yml     — Full stack: PostgreSQL + Keycloak + Grover
.env.example           — Template for environment variables (copy to .env)
```

### Web UI

`node grover.js serve` starts an HTTP server that:
- Serves `graph-viz.html` with embedded graph data at `/`
- Injects a chat panel for RAG Q&A with multi-chat sidebar
- Supports Keycloak OIDC authentication (login overlay, PKCE flow, server-side sessions in PostgreSQL)
- Provides an admin panel at `/admin` for user management and usage statistics
- Supports user feedback (thumbs up/down with categorization) for self-adaptive learning
- `GET /health` — Unauthenticated health check returning `{ status, index, chunks }`
- `POST /api/ask` — Query endpoint returning `{ answer, sources, path, mode }`
- `POST /api/ask-stream` — Streaming RAG via SSE
- `POST /api/forget` — Clears conversation memory
- Chat responses highlight the traversal path in the graph visualization
