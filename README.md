# Grover

PDF document search and RAG system for financial product documents. Combines ONNX vector embeddings, a knowledge graph, and LLM-powered Q&A to provide semantic search and natural language answers grounded in source documents.

Built for Westpac Group brand documents (Westpac, St.George, BankSA, Bank of Melbourne) covering foreign exchange, interest rate risk management, deposits, and loans.

## Features

- **PDF ingestion** with page-aware text chunking and local ONNX embeddings
- **Knowledge graph** linking brands, categories, documents, and financial entities
- **Hybrid search** combining vector similarity with graph traversal
- **RAG Q&A** with source citations and conversation memory
- **Web UI** with interactive graph visualization and chat panel
- **Incremental updates** — only re-processes new or modified PDFs

## Requirements

- **Node.js** >= 18 (tested on v25.4.0)
- **Python 3** with `pymupdf` package (for PDF text extraction)
- **npm** dependencies: `ruvector`, `@ruvector/ruvllm`

### Optional

- **OpenAI API key** (or compatible API) — required for RAG answers, not needed for search-only mode

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd grover

# Install Node.js dependencies
npm install

# Install Python PDF extraction library
pip install pymupdf
```

## Configuration

Set environment variables as needed:

```bash
# Required for RAG (ask, interactive, serve commands)
export OPENAI_API_KEY=sk-...

# Optional: use a different OpenAI-compatible endpoint
export OPENAI_BASE_URL=https://api.openai.com/v1

# Optional: use a different model (default: gpt-4o-mini)
export LLM_MODEL=gpt-4o-mini
```

## Usage

### 1. Prepare documents

Place PDF files in the `./corpus` directory. The system reads brand and category from the path structure:

```
docs/
└── Westpac/
    ├── wbc/           # Westpac
    │   ├── fx/        # Foreign Exchange
    │   ├── irrm/      # Interest Rate Risk Management
    │   ├── deps/      # Deposits
    │   └── loans/     # Loans
    ├── sgb/           # St.George Bank
    ├── bsa/           # BankSA
    └── bom/           # Bank of Melbourne
```

### 2. Build the index

```bash
# Full ingestion — extracts text, generates embeddings, builds knowledge graph
node search.js ingest
```

This creates the `./index/` directory containing:
- `embeddings.bin` — 384-dimensional Float32 vectors (~9 MB for ~6000 chunks)
- `metadata.json` — chunk text, file paths, page ranges
- `graph.json` — serialized knowledge graph

### 3. Search

```bash
# Semantic search with graph expansion
node search.js search "forward contract margin call"

# Return more results
node search.js search "interest rate swap" --k 10
```

Example output:
```
Loading index: 6220 chunks, 384d + graph

Results for: "forward contract margin call" (vector+graph)

  1. [0.1234] Westpac/wbc/fx/WBC-FXTransactionPDS.pdf (pp.5-6)  <- graph: shared_concept [+2.50 boost]
     A Forward Exchange Contract (FEC) is an agreement to exchange one currency...

  2. [0.1567] Westpac/sgb/fx/SGB-FXTransactionPDS.pdf (p.8)  <- graph: shared_concept [+1.75 boost]
     Margin calls may be made if the mark to market value of your position...
```

### 4. Ask questions (RAG)

Requires `OPENAI_API_KEY`.

```bash
# Single question with cited answer
node search.js ask "What are the margin call requirements for forward contracts?"
```

The system retrieves relevant chunks, builds context with conversation memory, and generates a cited answer:

```
  Sources:
    [1] Westpac/wbc/fx/WBC-FXTransactionPDS.pdf (pp.5-6) [0.1234]
    [2] Westpac/sgb/fx/SGB-FXTransactionPDS.pdf (p.8) [0.1567]

  Answer:

  Margin call requirements vary by brand:

  For Westpac, margin calls are triggered when the mark-to-market value
  of your forward contract position falls below... [Source 1]

  For St.George Bank, margin calls require... [Source 2]
```

### 5. Interactive mode

```bash
# RAG mode (if OPENAI_API_KEY set) or search-only mode
node search.js interactive
# or: node search.js i
```

Interactive commands:

| Command | Description |
|---------|-------------|
| `<query>` | Ask a question (RAG) or search (if no LLM) |
| `--search <query>` | Raw search results without LLM |
| `--flat <query>` | Vector-only search (no graph expansion) |
| `--k N <query>` | Return N results |
| `--related <file>` | Show documents related to a file |
| `--entities` | List all discovered financial entities |
| `--memory` | Show conversation memory statistics |
| `--forget` | Clear conversation memory |
| `quit` | Exit |

### 6. Web UI

```bash
# Start server (default port 3000)
node search.js serve

# Custom port
node search.js serve 8080
```

Opens a web interface at `http://localhost:3000` with:
- Interactive graph visualization (brands, categories, documents, entities)
- Chat panel for RAG Q&A
- Graph path highlighting showing how answers connect to the knowledge graph
- Source citation click-to-focus on the graph

### 7. Incremental updates

```bash
# Only processes new/modified/deleted PDFs, then rebuilds graph
node search.js update
```

Detects changes by comparing file modification times against the stored index.

### 8. Index statistics

```bash
node search.js stats
```

```
=== Index Statistics ===
Total PDFs: 103
Total chunks: 6220
Embedding dimensions: 384
Index size: 9.1 MB

=== Knowledge Graph ===
Nodes: 6384
  chunk: 6220
  document: 103
  concept: 33
  product: 20
  brand: 4
  category: 4
Edges: 32724
Entities tracked: 53

=== Conversation Memory ===
Past interactions: 2
History messages: 4
```

## Project Structure

```
search.js                  CLI dispatcher (delegates to src/commands/)
graph-viz.html             Graph visualization template (vis-network)
corpus/                    Source PDFs (organized by brand/category)
docs/                      System documentation (design docs)
index/                     Generated index files (git-ignored)
src/
├── config.js              File paths and environment variables
├── domain-constants.js    Financial domain vocabulary
├── utils/                 Shared utilities (math, PDF, formatting)
├── graph/                 Knowledge graph construction and traversal
├── memory/                Conversation memory with SONA trajectories
├── persistence/           Index save/load (binary + JSON)
├── retrieval/             Vector search and retrieval pipeline
├── llm/                   LLM client, query rewriting, RAG generation
├── server/                Visualization builder and chat panel HTML
└── commands/              CLI command implementations
```

## How It Works

1. **Ingestion**: PDFs are processed page-by-page via pymupdf, split into overlapping 1000-character chunks, embedded using a local ONNX model (all-MiniLM-L6-v2, 384 dimensions), and organized into a knowledge graph linking brands, categories, documents, and extracted financial entities.

2. **Search**: Queries are embedded with the same ONNX model and compared against all chunks via brute-force cosine distance (<50ms for ~6000 chunks). The knowledge graph expands results by following entity co-occurrence and semantic similarity edges across documents. Final scoring: `vectorScore - (graphScore * 0.15)`.

3. **RAG**: Retrieved chunks are formatted as numbered sources, combined with relevant past interactions from conversation memory, and sent to an LLM for answer generation with inline source citations.

4. **Memory**: Each Q&A interaction is stored with its query embedding. On subsequent queries, similar past interactions are retrieved and included in the LLM context. Short or referential follow-up queries are rewritten into standalone searches.

## Design Documentation

- [High-Level Design](docs/high-level-design.md) — System overview, architecture diagram, data flows, key design decisions
- [Detailed Design](docs/detailed-design.md) — Module specifications, dependency graph, data formats, scoring algorithm

## License

ISC
