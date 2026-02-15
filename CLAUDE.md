# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Grover is a PDF document search and RAG (Retrieval-Augmented Generation) system for financial product documents from Westpac Group brands (Westpac/WBC, St.George/SGB, BankSA/BSA, Bank of Melbourne/BOM). It ingests PDFs, builds ONNX vector embeddings + a knowledge graph, and supports semantic search, LLM-powered Q&A, and a web UI with graph visualization.

The entire application lives in a single file: `search.js` (~2000 lines, CommonJS).

## Commands

```bash
# Ingest PDFs from ./docs into vector index + knowledge graph
node search.js ingest

# Incremental update (new/modified/deleted PDFs only)
node search.js update

# Vector + graph search
node search.js search "query text"

# RAG Q&A (requires OPENAI_API_KEY)
node search.js ask "question"

# Interactive REPL (RAG if LLM configured, else search-only)
node search.js interactive   # or: node search.js i

# Web UI with graph visualization + chat panel (default port 3000)
node search.js serve          # or: node search.js web
node search.js serve 8080     # custom port

# Index statistics
node search.js stats
```

There is no build step, no linter, and no test suite configured.

## Environment Variables

- `OPENAI_API_KEY` — Required for RAG (`ask`, `interactive`, `serve`). Any OpenAI-compatible API works.
- `OPENAI_BASE_URL` — Override API endpoint (default: `https://api.openai.com/v1`)
- `LLM_MODEL` — Override model (default: `gpt-4o-mini`)

## Architecture

### Data Flow

1. **Ingest**: PDFs in `./docs` → Python (`pymupdf`) text extraction → page-aware chunking (1000 char, 200 overlap) → ONNX embeddings via `ruvector` → knowledge graph construction → persisted to `./index/`
2. **Search**: Query → ONNX embedding → brute-force cosine distance against all chunks → knowledge graph expansion (entity co-occurrence, cross-doc similarity) → ranked results
3. **RAG**: Search results → formatted context + conversation memory → OpenAI-compatible chat completion → answer with source citations

### Key Dependencies

- **`ruvector`** — Rust/NAPI vector database with ONNX embedding support. Used for `rv.initOnnxEmbedder()`, `rv.embed()`, `rv.getDimension()`. The actual search uses a custom brute-force implementation (not the DB's search), operating directly on Float32Arrays.
- **`@ruvector/ruvllm`** — Provides `ReasoningBank` (embedding storage/retrieval), `SonaCoordinator` (trajectory recording/pattern learning), and `TrajectoryBuilder` (step-based trajectory tracking). Used for conversation memory.
- **`pymupdf`** (Python) — PDF text extraction, invoked via `child_process.execSync`. Python 3 with pymupdf must be installed.

### Knowledge Graph

The `KnowledgeGraph` class builds an in-memory graph with these node types:
- **brand** — WBC, SGB, BSA, BOM
- **category** — FX, IRRM, Deposits, Loans
- **document** — One per PDF file
- **chunk** — One per text chunk
- **product/concept** — Extracted entities (forward contracts, margin calls, etc.)

Edges encode: `part_of`, `contains`, `belongs_to_brand`, `in_category`, `mentions`, `shared_concept`, `semantically_similar`. Graph expansion boosts search results by following these relationships across documents.

### Conversation Memory

`ConversationMemory` persists Q&A history to `./index/memory.json`. It stores query embeddings and uses cosine similarity to find relevant past interactions. Follow-up queries are rewritten into standalone searches via LLM when they appear referential.

### File Layout

```
search.js           — Entire application (CLI, server, ingestion, search, RAG, graph, memory)
graph-viz.html      — vis-network graph visualization template (served by web UI)
docs/               — Source PDFs organized by brand/category (docs/Westpac/{bom,bsa,sgb,wbc}/{fx,irrm,...}/)
index/              — Generated index files (embeddings.bin, metadata.json, graph.json, memory.json)
```

### Web UI

`node search.js serve` starts an HTTP server that:
- Serves `graph-viz.html` with embedded graph data at `/`
- Injects a chat panel for RAG Q&A
- `POST /api/ask` — Query endpoint returning `{ answer, sources, path, mode }`
- `POST /api/forget` — Clears conversation memory
- Chat responses highlight the traversal path in the graph visualization
