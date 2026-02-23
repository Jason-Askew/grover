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

There is no build step, no linter, and no test suite configured.

## Environment Variables

- `OPENAI_API_KEY` — Required for RAG (`ask`, `interactive`, `serve`). Any OpenAI-compatible API works.
- `OPENAI_BASE_URL` — Override API endpoint (default: `https://api.openai.com/v1`)
- `LLM_MODEL` — Override model (default: `gpt-4o-mini`)
- `KEYCLOAK_URL` — Keycloak server URL (enables OIDC authentication when set)
- `KEYCLOAK_REALM` — Keycloak realm name (default: `grover`)
- `KEYCLOAK_CLIENT_ID` — Keycloak client ID (default: `grover-web`)
- `AUTH_SESSION_TTL` — Session TTL in ms (default: `86400000` / 24h)

## Architecture

### Data Flow

1. **Ingest**: PDFs in `./corpus` → Python (`pymupdf`) text extraction → page-aware chunking (1000 char, 200 overlap) → ONNX embeddings via `ruvector` → knowledge graph construction → persisted to `./index/`
2. **Search**: Query → ONNX embedding → brute-force cosine distance against all chunks → knowledge graph expansion (entity co-occurrence, cross-doc similarity) → ranked results
3. **RAG**: Search results → formatted context + conversation memory → OpenAI-compatible chat completion → answer with source citations

### Key Dependencies

- **`ruvector`** — Rust/NAPI vector database with ONNX embedding support. Used for `rv.initOnnxEmbedder()`, `rv.embed()`, `rv.getDimension()`. The actual search uses a custom brute-force implementation (not the DB's search), operating directly on Float32Arrays.
- **`@ruvector/ruvllm`** — Provides `ReasoningBank` (embedding storage/retrieval), `SonaCoordinator` (trajectory recording/pattern learning), and `TrajectoryBuilder` (step-based trajectory tracking). Used for conversation memory.
- **`pymupdf`** (Python) — PDF text extraction, invoked via `child_process.execSync`. Python 3 with pymupdf must be installed.
- **`jose`** — JWT/JWKS validation for Keycloak OIDC authentication.
- **`@aws-sdk/client-polly`** — Amazon Polly text-to-speech.

### Knowledge Graph

The `KnowledgeGraph` class builds an in-memory graph with these node types:
- **brand** — WBC, SGB, BSA, BOM (Westpac domain only; SA uses categories-only, no brands)
- **category** — FX, IRRM, Deposits, Loans (Westpac); 31 categories for SA including Centrelink, Medicare, Child Support, etc.
- **document** — One per PDF file
- **chunk** — One per text chunk
- **product/concept** — Extracted entities (forward contracts, margin calls, JobSeeker, income test, etc.)

Edges encode: `part_of`, `contains`, `belongs_to_brand`, `in_category`, `mentions`, `shared_concept`, `semantically_similar`. Graph expansion boosts search results by following these relationships across documents.

### Conversation Memory

`ConversationMemory` persists Q&A history per chat (each chat has its own memory file). It stores query embeddings and uses cosine similarity to find relevant past interactions. Follow-up queries are rewritten into standalone searches via LLM when they appear referential. `ChatManager` provides per-user multi-chat isolation with auto-titling and legacy migration.

### File Layout

```
grover.js           — CLI dispatcher (delegates to src/commands/)
src/                — Modular source code (config, utils, graph, memory, llm, retrieval, commands, server)
graph-viz.html      — vis-network graph visualization template (served by web UI)
corpus/             — Source PDFs organized by brand/category (corpus/Westpac/{bom,bsa,sgb,wbc}/{fx,irrm,...}/)
docs/               — System documentation (design docs)
index/              — Generated index files (embeddings.bin, metadata.json, graph.json, chats.json, etc.)
config/             — External configuration (docker-compose for Keycloak)
```

### Web UI

`node grover.js serve` starts an HTTP server that:
- Serves `graph-viz.html` with embedded graph data at `/`
- Injects a chat panel for RAG Q&A with multi-chat sidebar
- Supports Keycloak OIDC authentication (login overlay, PKCE flow, server-side sessions)
- Provides an admin panel at `/admin` for user management and usage statistics
- Supports user feedback (thumbs up/down with categorization) for self-adaptive learning
- `POST /api/ask` — Query endpoint returning `{ answer, sources, path, mode }`
- `POST /api/ask-stream` — Streaming RAG via SSE
- `POST /api/forget` — Clears conversation memory
- Chat responses highlight the traversal path in the graph visualization
