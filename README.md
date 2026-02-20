# Grover

Document search and RAG system combining local ONNX vector embeddings, a knowledge graph, adaptive conversation memory, and LLM-powered Q&A. Supports semantic search, natural language answers grounded in source citations, and an interactive web UI with graph visualization.

Designed for multi-brand document corpora. Ships with domain vocabularies for Westpac Group financial products (Westpac, St.George, BankSA, Bank of Melbourne) and Services Australia government services (Centrelink, Medicare, Child Support, myGov).

## Features

- **PDF and Markdown ingestion** with page-aware chunking and local ONNX embeddings (no external API for embeddings)
- **Knowledge graph** linking brands, categories, documents, products, and domain concepts
- **Hybrid search** combining vector cosine similarity with graph traversal expansion
- **RAG Q&A** with inline source citations and streaming responses
- **Adaptive conversation memory** with SONA trajectory tracking, pattern learning, and semantic retrieval of past interactions
- **Multi-index support** — isolated indexes per corpus with runtime switching
- **Web UI** with interactive graph visualization, document viewer, memory graph, chat panel, and voice interface
- **Incremental updates** — only re-processes new or modified files
- **Text-to-speech** via Amazon Polly with sentence-level streaming
- **Speech-to-text** via browser Web Speech API

## Requirements

- **Node.js** >= 18
- **Python 3** with `pymupdf` package (for PDF text extraction)

### Optional

- **OpenAI API key** (or any compatible API) — required for RAG answers; without it the system runs in search-only mode
- **AWS credentials** — required for Amazon Polly text-to-speech

## Installation

```bash
git clone <repo-url>
cd grover
npm install
pip install pymupdf
```

## Configuration

```bash
# Required for RAG (ask, interactive, serve commands)
export OPENAI_API_KEY=sk-...

# Optional: OpenAI-compatible endpoint (default: https://api.openai.com/v1)
export OPENAI_BASE_URL=https://api.openai.com/v1

# Optional: model override (default: gpt-4o-mini)
export LLM_MODEL=gpt-4o-mini

# Optional: Amazon Polly TTS
export AWS_REGION=ap-southeast-2
export POLLY_VOICE=Olivia          # default: Olivia
export POLLY_ENGINE=neural         # default: neural
```

## Usage

All commands accept an optional `--index <name>` flag to target a specific named index. Without it, the first available index is used.

### Ingest documents

Place source files in `./corpus/<index-name>/`. The system reads brand and category from the directory structure:

```
corpus/
└── ServicesAustralia/
    ├── general/
    ├── employment/
    ├── disability/
    └── ...
```

PDF and Markdown files are supported. Markdown files can include YAML front-matter with `title`, `url`, and `source` fields.

```bash
# Full ingestion — extract text, generate embeddings, build knowledge graph
node search.js ingest --index ServicesAustralia

# Incremental update — only re-processes new/modified/deleted files
node search.js update --index ServicesAustralia
```

### Search

```bash
# Semantic search with graph expansion
node search.js search "mutual obligation requirements"

# Return more results
node search.js search "income test thresholds" --k 10
```

### Ask questions (RAG)

Requires `OPENAI_API_KEY`.

```bash
node search.js ask "What are the eligibility requirements for JobSeeker?"
```

Retrieves relevant chunks, builds context with conversation memory, and generates a cited answer.

### Interactive mode

```bash
node search.js interactive   # or: node search.js i
```

| Command | Description |
|---------|-------------|
| `<query>` | Ask a question (RAG) or search (if no LLM) |
| `--search <query>` | Raw search results without LLM |
| `--flat <query>` | Vector-only search (no graph expansion) |
| `--k N <query>` | Return N results |
| `--related <file>` | Show documents related to a file |
| `--entities` | List all discovered entities from the graph |
| `--memory` | Show conversation memory and SONA trajectory stats |
| `--forget` | Clear conversation memory and reset learning state |
| `quit` | Exit |

### Web UI

```bash
node search.js serve          # default port 3000
node search.js serve 8080     # custom port
```

Opens `http://localhost:3000` with:

- **Knowledge graph** — interactive vis-network visualization of brands, categories, documents, and entities with brand-themed colors
- **Cascading filters** — toggle node types, individual values, and relationship types; filtering a brand cascades to hide its documents and entities
- **Document viewer** — click any document node to view its full text with metadata and source URL
- **Memory graph** — toggle the "Memory" button to visualize conversation history as a graph with Q&A nodes, source nodes, chronological edges, citation edges, and topic-similarity edges
- **Chat panel** — RAG Q&A with streaming token rendering, source citations, and graph path highlighting
- **Voice interface** — microphone input (Web Speech API) and text-to-speech output (Amazon Polly) with sentence-level audio streaming
- **Index switching** — select any available index from the dropdown without restarting the server

### Index statistics

```bash
node search.js stats
```

## Architecture

### Data flow

1. **Ingest** — PDFs/Markdown in `./corpus/` are extracted, split into overlapping 1000-char chunks (200 overlap), embedded using a local ONNX model (all-MiniLM-L6-v2, 384d), and organized into a knowledge graph.

2. **Search** — Query is embedded with the same model and compared via brute-force cosine distance against all chunks. The knowledge graph expands results by following entity co-occurrence and semantic similarity edges across documents. Graph boost is capped at 30% of the vector score range.

3. **RAG** — Retrieved chunks are formatted as numbered sources, combined with relevant past interactions from conversation memory, and sent to an LLM with a brand-aware system prompt for answer generation with inline citations.

4. **Memory & Learning** — Each Q&A interaction is stored with its query embedding. On subsequent queries, semantically similar past interactions (cosine similarity > 0.5) are retrieved and included in LLM context. Follow-up queries are automatically rewritten into standalone searches via the LLM.

### Adaptive learning

The system uses three components from `@ruvector/ruvllm` for adaptive learning:

- **ReasoningBank** — stores query embeddings from each interaction, building a growing bank of reasoning patterns
- **SonaCoordinator** — records trajectories from each Q&A cycle and learns patterns across interactions; trajectory and pattern counts are surfaced via the `--memory` command
- **TrajectoryBuilder** — captures a two-step trajectory per interaction (retrieval performance + generation performance) with quality scoring, which is fed to the SonaCoordinator for pattern learning

Memory is per-index — switching indexes also switches conversation context and learning state. All memory state (history, memories, ReasoningBank, SonaCoordinator) can be reset via `--forget` or the UI clear button.

### Knowledge graph

The graph connects:

| Node type | Description |
|-----------|-------------|
| brand | Top-level service (Westpac, Centrelink, etc.) |
| category | Product/service category (FX, employment, disability, etc.) |
| document | One per source file |
| product | Extracted product entities (forward contracts, JobSeeker, etc.) |
| concept | Extracted domain concepts (margin calls, income test, etc.) |

Edges encode `belongs_to_brand`, `in_category`, `mentions`, `shared_concept`, and `semantically_similar` relationships. Graph expansion during search follows these edges to surface related content across documents.

### Entity extraction

Entity extraction uses domain-specific vocabularies:

- **Westpac domain** — 23 product types, 28 financial concepts, 4 brands, 4 categories
- **Services Australia domain** — ~50 payment types, ~60 government concepts, 4 brands, 19 categories

Extraction is case-insensitive substring matching. Brand and category metadata is derived from the file path hierarchy.

### Query rewriting

Follow-up queries (short queries or those starting with referential phrases like "what about", "same for", "compared to") are automatically rewritten into standalone search queries using the LLM, with the last 4 conversation messages as context.

## API Reference

The web server exposes these endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Graph visualization with embedded data and chat panel |
| GET | `/api/indexes` | List all available indexes with metadata |
| POST | `/api/switch` | Switch active index at runtime |
| POST | `/api/ask` | Non-streaming RAG Q&A |
| POST | `/api/ask-stream` | Streaming RAG via SSE (`sources`, `token`, `done`, `error` events) |
| GET | `/api/document?file=<path>` | Full document text and metadata |
| GET | `/api/memory` | Conversation memory (interactions without embeddings) |
| POST | `/api/tts` | Text-to-speech via Amazon Polly (returns base64 MP3) |
| POST | `/api/forget` | Clear conversation memory and reset learning state |

## Project Structure

```
search.js                  CLI dispatcher
graph-viz.html             Graph visualization + memory graph (vis-network)
corpus/                    Source documents per index
index/                     Generated index files per index (git-ignored)
src/
  config.js                Paths, environment variables, index resolution
  domain-constants.js      Westpac financial domain vocabulary
  domain-constants-sa.js   Services Australia domain vocabulary
  utils/                   PDF extraction, markdown parsing, math helpers
  graph/                   Knowledge graph construction, entity extraction
  memory/                  Conversation memory with SONA trajectories
  persistence/             Index save/load (binary embeddings + JSON)
  retrieval/               Vector search and hybrid retrieval pipeline
  llm/                     LLM client, query rewriting, RAG generation
  server/                  Viz data builder and chat panel HTML
  commands/                CLI command implementations (ingest, serve, etc.)
docs/                      Design documentation
```

## Design Documentation

- [High-Level Design](docs/high-level-design.md) — System overview, architecture diagram, data flows, key design decisions
- [Detailed Design](docs/detailed-design.md) — Module specifications, dependency graph, data formats, scoring algorithm

## License

ISC
