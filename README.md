# Grover

Document search and RAG system combining local ONNX vector embeddings, a knowledge graph, adaptive conversation memory, and LLM-powered Q&A. Supports semantic search, natural language answers grounded in source citations, and an interactive web UI with graph visualization.

Designed for multi-domain document corpora. Ships with domain vocabularies for Westpac Group financial products (Westpac, St.George, BankSA, Bank of Melbourne) and Services Australia government services (Centrelink, Medicare, Child Support, myGov).

## Features

- **PDF and Markdown ingestion** with page-aware chunking and local ONNX embeddings (no external API for embeddings)
- **Knowledge graph** linking brands, categories, documents, products, and domain concepts
- **Hybrid search** combining vector cosine similarity with graph traversal expansion
- **RAG Q&A** with inline source citations and streaming responses
- **Adaptive conversation memory** with SONA trajectory tracking, pattern learning, and semantic retrieval of past interactions
- **Multi-index support** — isolated indexes per corpus with runtime switching
- **Keycloak OIDC authentication** — PKCE flow with JWKS validation, server-side sessions, role-based access
- **Multi-chat management** — per-user chat isolation, auto-titling, chat switching, rename, delete
- **Admin panel** — user management (CRUD via Keycloak Admin REST API), usage statistics dashboard
- **Usage tracking** — per-user and per-model token counting with cost estimation
- **User feedback** — thumbs up/down with categorization, content-keyed quality scoring, cross-user shared feedback index, SONA trajectory integration
- **Category inference** — 4-tier filename analysis (form codes, language detection, keyword rules, medical patterns) achieving 100% category coverage for Services Australia corpus
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
- **Keycloak server** — required for authentication; without it the system runs in anonymous mode
- **Docker** — for running Keycloak locally via Docker Compose

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

# Optional: Amazon Polly TTS (requires AWS credentials)
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=ap-southeast-2
export POLLY_VOICE=Olivia          # default: Olivia
export POLLY_ENGINE=neural         # default: neural

# Optional: Keycloak OIDC authentication (omit to run without auth)
export KEYCLOAK_URL=http://localhost:8080
export KEYCLOAK_REALM=grover             # default: grover
export KEYCLOAK_CLIENT_ID=grover-web     # default: grover-web
export AUTH_SESSION_TTL=86400000         # default: 24h in ms
export KEYCLOAK_ADMIN_USER=admin         # for admin panel user management
export KEYCLOAK_ADMIN_PASSWORD=admin

# Optional: custom LLM cost tracking
export LLM_COST_PER_1K_INPUT=0.00015
export LLM_COST_PER_1K_OUTPUT=0.0006
```

A `docker-compose.yml` is provided in the project root for running Keycloak locally.

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
node grover.js ingest --index ServicesAustralia

# Incremental update — only re-processes new/modified/deleted files
node grover.js update --index ServicesAustralia
```

### Search

```bash
# Semantic search with graph expansion
node grover.js search "mutual obligation requirements"

# Return more results
node grover.js search "income test thresholds" --k 10
```

### Ask questions (RAG)

Requires `OPENAI_API_KEY`.

```bash
node grover.js ask "What are the eligibility requirements for JobSeeker?"
```

Retrieves relevant chunks, builds context with conversation memory, and generates a cited answer.

### Interactive mode

```bash
node grover.js interactive   # or: node grover.js i
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
node grover.js serve          # default port 3000
node grover.js serve 8080     # custom port
```

Opens `http://localhost:3000` with:

- **Knowledge graph** — interactive vis-network visualization of brands, categories, documents, and entities with brand-themed colors
- **Cascading filters** — toggle node types, individual values, and relationship types; filtering a brand cascades to hide its documents and entities
- **Document viewer** — click any document node to view its full text with metadata and source URL
- **Memory graph** — toggle the "Memory" button to visualize conversation history as a graph with Q&A nodes, source nodes, chronological edges, citation edges, and topic-similarity edges
- **Chat panel** — RAG Q&A with streaming token rendering, source citations, and graph path highlighting
- **Multi-chat sidebar** — create, switch, rename, and delete independent conversation threads; auto-titles from the first query
- **Feedback buttons** — thumbs up/down on each answer with optional categorization (wrong answer + wrong docs, wrong answer + right docs, right answer + wrong docs, incomplete answer); feedback adjusts quality scores for future memory retrieval
- **Voice interface** — microphone input (Web Speech API) and text-to-speech output (Amazon Polly) with sentence-level audio streaming
- **Index switching** — select any available index from the dropdown without restarting the server
- **Authentication** — when `KEYCLOAK_URL` is set, the login overlay handles PKCE-based OIDC flow; sessions are server-side with HttpOnly cookies
- **Admin panel** — available at `/admin` for users with the `admin` role; provides user management (list, create, edit, delete, reset password) and token usage statistics

### Index statistics

```bash
node grover.js stats
```

## Architecture

### Data flow

1. **Ingest** — PDFs/Markdown in `./corpus/` are extracted, split into overlapping 1000-char chunks (200 overlap), embedded using a local ONNX model (all-MiniLM-L6-v2, 384d), and organized into a knowledge graph. Embedding is performed in batch child processes to isolate the ONNX WASM runtime's memory from the parent process.

2. **Search** — Query is embedded with the same model and compared via brute-force cosine distance against all chunks. The knowledge graph expands results by following entity co-occurrence and semantic similarity edges across documents. Graph boost is capped at 30% of the vector score range.

3. **RAG** — Retrieved chunks are formatted as numbered sources, combined with relevant past interactions from conversation memory (quality-weighted by feedback), and sent to an LLM with a domain-aware system prompt (customized per index) for answer generation with inline citations.

4. **Memory & Learning** — Each Q&A interaction is stored with its query embedding (capped at 200 memories with LRU eviction). On subsequent queries, semantically similar past interactions (cosine similarity > 0.5, weighted by feedback quality) are retrieved and included in LLM context. Follow-up queries are automatically rewritten into standalone searches via the LLM. Negative feedback annotations are surfaced to the LLM to avoid repeating issues.

5. **Authentication** — When `KEYCLOAK_URL` is set, the browser performs a PKCE-based OIDC flow. The server validates the id_token against Keycloak's JWKS endpoint, creates a server-side session, and sets an HttpOnly cookie. All API endpoints check the session. When auth is disabled, all requests proceed as an anonymous user.

### Adaptive learning

The system uses three components from `@ruvector/ruvllm` for adaptive learning:

- **ReasoningBank** — stores query embeddings from each interaction, building a growing bank of reasoning patterns
- **SonaCoordinator** — records trajectories from each Q&A cycle and learns patterns across interactions; trajectory and pattern counts are surfaced via the `--memory` command
- **TrajectoryBuilder** — captures a two-step trajectory per interaction (retrieval performance + generation performance) with quality scoring, which is fed to the SonaCoordinator for pattern learning. Feedback events also generate trajectories.

Memory is per-user and per-chat — each chat has its own memory file with isolated conversation history and learning state. All memory state (history, memories, ReasoningBank, SonaCoordinator) can be reset via `--forget` or the UI clear button.

### Knowledge graph

The graph connects:

| Node type | Description |
|-----------|-------------|
| brand | Top-level service (Westpac, St.George, etc.) — not used for SA |
| category | Product/service category (FX, employment, disability, etc.) |
| document | One per source file |
| product | Extracted product entities (forward contracts, JobSeeker, etc.) |
| concept | Extracted domain concepts (margin calls, income test, etc.) |

Edges encode `belongs_to_brand`, `in_category`, `mentions`, `shared_concept`, and `semantically_similar` relationships. Graph expansion during search follows these edges to surface related content across documents.

### Entity extraction

Entity extraction uses domain-specific vocabularies with pre-compiled word-boundary regular expressions:

- **Westpac domain** — 23 product types, 28 financial concepts, 4 brands, 4 categories
- **Services Australia domain** — ~55 payment types, ~74 government concepts, 0 brands (SA uses categories-only), 33 categories

Brand and category metadata is derived from the file path hierarchy. For the SA corpus, a 4-tier category inference system ensures 100% coverage:

1. **Form code detection** — two-letter prefix + digits (`fa012`, `mod-pc`) → `forms`
2. **Language/translation detection** — known language basenames and `*translation` patterns → `translations`
3. **Keyword rules** — ~40 ordered rules matching filename patterns to specific categories (specific → general, first match wins)
4. **Medical condition detection** — broad pattern for PBS pharmaceutical benefits pages → `pharmaceutical-benefits`

The viz builder performs retroactive reassignment of documents initially classified as `general` to their inferred categories, and merges legacy brand nodes that duplicate category nodes (since SA_BRANDS was emptied).

### Batch embedding architecture

The ONNX WASM runtime pre-allocates ~4GB of WebAssembly memory that V8 counts against Node.js's heap limit. To handle large corpora (thousands of files), ingestion and updates use a batch child process architecture:

1. The parent process splits files into batches of 500
2. Each batch spawns a short-lived child process with `--max-old-space-size=6144`
3. The child loads the ONNX model, embeds all chunks, writes embeddings (binary) and metadata (JSON) to disk
4. The child exits, fully releasing the WASM memory allocation
5. The parent merges all batch results and builds the knowledge graph

This ensures bounded memory usage regardless of corpus size.

### Query rewriting

Follow-up queries (short queries or those starting with referential phrases like "what about", "same for", "compared to") are automatically rewritten into standalone search queries using the LLM, with the last 4 conversation messages as context.

## API Reference

The web server exposes these endpoints:

### Core

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
| POST | `/api/feedback` | Record thumbs up/down feedback on a memory entry |

### Chat Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chats` | List all chats for the current user |
| POST | `/api/chats` | Create a new chat |
| DELETE | `/api/chats?id=<chatId>` | Delete a chat |
| POST | `/api/chats/switch` | Switch the active chat |
| POST | `/api/chats/rename` | Rename a chat |
| GET | `/api/chats/history?chatId=<id>` | Get chat message history |

### Authentication (requires `KEYCLOAK_URL`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/callback` | Serves the OIDC callback HTML page |
| POST | `/api/auth/session` | Exchange id_token for a server-side session |
| POST | `/api/auth/logout` | Destroy session and return Keycloak logout URL |
| GET | `/api/auth/me` | Return current authenticated user info |

### Admin (requires `admin` role)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin` | Admin panel HTML page |
| GET | `/api/admin/users` | List Keycloak users |
| POST | `/api/admin/users` | Create a new user |
| PUT | `/api/admin/users/:id` | Update a user |
| POST | `/api/admin/users/:id/reset-password` | Reset user password |
| DELETE | `/api/admin/users/:id` | Delete a user |
| GET | `/api/admin/usage` | Token usage statistics |

## Project Structure

```
grover.js                  CLI dispatcher
graph-viz.html             Graph visualization + memory graph (vis-network)
docker-compose.yml         Keycloak local development setup
corpus/                    Source documents per index
index/                     Generated index files per index (git-ignored)
config/                    External configuration files
src/
  config.js                Paths, environment variables, index resolution, Keycloak config
  domain-constants.js      Westpac financial domain vocabulary
  domain-constants-sa.js   Services Australia domain vocabulary (33 categories, ~55 payments, ~74 concepts)
  utils/                   PDF extraction, markdown parsing, chunking, math helpers
  utils/embed-batch.js     Batch embedding child process worker (ONNX isolation)
  graph/                   Knowledge graph construction, entity extraction, category inference
  memory/
    conversation-memory.js Conversation memory with SONA trajectories and feedback
    chat-manager.js        Per-user multi-chat isolation, auto-titling, legacy migration
    feedback-index.js      Content-keyed shared feedback index with quality scoring
  persistence/             Index save/load (binary embeddings + JSON)
  retrieval/               Vector search and hybrid retrieval pipeline
  llm/
    client.js              OpenAI-compatible HTTP client (streaming + non-streaming)
    query-rewrite.js       Follow-up query expansion via LLM
    rag.js                 Domain-aware RAG generation with memory + feedback integration
    usage-tracker.js       Per-user/per-model token counting and cost estimation
  server/
    viz-builder.js         Graph-to-visualization data transformer (retroactive category inference)
    viz-path.js            Citation subgraph extraction for path highlighting
    chat-panel.html        Injected chat panel (HTML/CSS/JS)
    login-overlay.html     Keycloak OIDC login overlay (PKCE flow)
    auth-callback.html     OIDC callback page
    auth.js                Keycloak OIDC validation, sessions, auth middleware
    admin-api.js           Admin routes (user CRUD via Keycloak Admin REST API, usage stats)
    admin-panel.html       Admin panel HTML page
  commands/                CLI command implementations (ingest, serve, etc.)
docs/                      Design documentation
```

## Design Documentation

- [High-Level Design](docs/high-level-design.md) — System overview, architecture diagram, data flows, key design decisions
- [Detailed Design](docs/detailed-design.md) — Module specifications, dependency graph, data formats, scoring algorithm

## License

ISC
