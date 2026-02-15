# Grover: High-Level Design

## 1. System Overview

Grover is a PDF document search and RAG (Retrieval-Augmented Generation) system designed for financial product documents from Westpac Group brands (Westpac, St.George, BankSA, Bank of Melbourne). It combines vector embeddings, a knowledge graph, and LLM-powered Q&A to provide semantic search and natural language answers grounded in source documents.

## 2. Key Capabilities

| Capability | Description |
|-----------|-------------|
| **PDF Ingestion** | Extracts text from PDFs, splits into page-aware chunks, generates ONNX vector embeddings |
| **Knowledge Graph** | Builds an in-memory graph of brands, categories, documents, entities, and their relationships |
| **Semantic Search** | Brute-force cosine distance search over 384-dimensional embeddings, boosted by graph traversal |
| **RAG Q&A** | Retrieves relevant chunks, constructs context with conversation history, generates cited answers via LLM |
| **Conversation Memory** | Persists Q&A history, finds relevant past interactions by embedding similarity, rewrites follow-up queries |
| **Web UI** | Interactive graph visualization (vis-network) with integrated chat panel |

## 3. Architecture Diagram

```
                           ┌─────────────────────────────┐
                           │      CLI Dispatcher          │
                           │        search.js             │
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
     ▼                         ▼                             ▼
┌──────────┐            ┌──────────┐                  ┌──────────────┐
│Knowledge │            │  LLM /   │                  │  Viz Builder │
│  Graph   │            │   RAG    │                  │  + Graph     │
└──────────┘            └────┬─────┘                  └──────────────┘
                             │
                             ▼
                      ┌──────────────┐
                      │ Conversation │
                      │   Memory     │
                      └──────────────┘
```

## 4. Data Flow

### 4.1 Ingestion Pipeline

```
PDFs in ./corpus/
    │
    ▼  Python (pymupdf)
Page-level text extraction
    │
    ▼  chunkPages()
Page-aware chunks (1000 char, 200 overlap)
    │
    ▼  ruvector ONNX (all-MiniLM-L6-v2)
384-dimensional embeddings per chunk
    │
    ├──▶ KnowledgeGraph.buildFromRecords()
    │       • Brand/category/document/chunk/entity nodes
    │       • Entity co-occurrence edges (cross-document)
    │       • Semantic similarity edges (cosine > 0.85)
    │
    └──▶ saveIndex()
            • embeddings.bin  (Float32, ~9 MB for 6220 chunks)
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
    ▼  ragAnswer() — format context, call LLM with memory
Cited answer + source references
```

### 4.3 Conversation Memory Flow

```
Q&A interaction
    │
    ├──▶ ConversationMemory.store()
    │       • Embed query → store in ReasoningBank
    │       • Record trajectory in SONA coordinator
    │       • Persist to memory.json (last 100 messages)
    │
    └──▶ On next query:
            • findRelevant() — cosine similarity against past queries
            • getRecentHistory() — last 6 messages for LLM context
            • rewriteQuery() — expand follow-ups into standalone queries
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

### 5.4 Modular Architecture

The application is organized into a layered module structure with strict dependency rules to prevent circular imports. Each module has a single responsibility and clear public API.

## 6. External Dependencies

| Dependency | Purpose | Required For |
|-----------|---------|-------------|
| `ruvector` | Rust/NAPI vector DB with ONNX embedding | All operations |
| `@ruvector/ruvllm` | ReasoningBank, SONA coordinator, trajectories | Conversation memory |
| `pymupdf` (Python) | PDF text extraction | Ingestion only |
| OpenAI-compatible API | LLM chat completions | RAG answers only |

## 7. Deployment Model

Grover runs as a single-process Node.js application. There is no database server, message queue, or container orchestration — all state is stored in flat files under `./index/`. This makes it suitable for local or small-team use on a single machine.
