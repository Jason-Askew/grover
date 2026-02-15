#!/usr/bin/env node

const rv = require('ruvector');
const { ReasoningBank, SonaCoordinator, TrajectoryBuilder } = require('@ruvector/ruvllm');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');
const readline = require('readline');

const DOCS_DIR = './docs';
const INDEX_DIR = './index';
const META_FILE = path.join(INDEX_DIR, 'metadata.json');
const EMBEDDINGS_FILE = path.join(INDEX_DIR, 'embeddings.bin');
const GRAPH_FILE = path.join(INDEX_DIR, 'graph.json');
const MEMORY_FILE = path.join(INDEX_DIR, 'memory.json');

// ─── LLM Config ─────────────────────────────────────────────

const LLM_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// ─── Conversation Memory (ruvllm) ───────────────────────────

class ConversationMemory {
  constructor() {
    this.reasoningBank = new ReasoningBank();
    this.sona = new SonaCoordinator();
    this.history = [];       // { role, content, timestamp }
    this.memories = [];      // { id, query, answer, sources, embedding, timestamp, quality }
    this.loaded = false;
  }

  // Load persisted memory from disk and rebuild ReasoningBank
  load() {
    if (this.loaded) return;
    if (fs.existsSync(MEMORY_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
        this.history = data.history || [];
        this.memories = data.memories || [];

        // Rebuild ReasoningBank with stored embeddings
        for (const mem of this.memories) {
          if (mem.embedding) {
            const emb = new Float32Array(mem.embedding);
            this.reasoningBank.store('qa', emb);
          }
        }
        console.log(`  Memory loaded: ${this.memories.length} past interactions, ${this.history.length} messages`);
      } catch (e) {
        console.log(`  Memory load error: ${e.message}`);
      }
    }
    this.loaded = true;
  }

  // Save memory to disk
  save() {
    if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
    // Convert Float32Arrays to regular arrays for JSON serialization
    const data = {
      history: this.history.slice(-100), // Keep last 100 messages
      memories: this.memories.map(m => ({
        ...m,
        embedding: m.embedding ? Array.from(m.embedding) : null,
      })),
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data));
  }

  // Store a Q&A interaction with its ONNX embedding
  async store(query, answer, sources, queryEmbedding) {
    const memory = {
      id: `mem-${Date.now()}`,
      query,
      answer: answer.slice(0, 2000), // cap stored answer length
      sources: sources.map(s => ({
        file: s.file,
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
        score: s.combinedScore ?? s.score ?? s.vectorScore ?? 0,
      })),
      embedding: Array.from(queryEmbedding),
      timestamp: new Date().toISOString(),
      quality: 1.0, // can be updated via feedback
    };

    this.memories.push(memory);

    // Store in ReasoningBank for similarity retrieval
    this.reasoningBank.store('qa', queryEmbedding);

    // Add to conversation history
    this.history.push({ role: 'user', content: query, timestamp: memory.timestamp });
    this.history.push({ role: 'assistant', content: answer.slice(0, 500), timestamp: memory.timestamp });

    // Record trajectory in SONA
    const tb = new TrajectoryBuilder();
    const s1 = tb.startStep('retrieval', { query, sourcesCount: sources.length });
    tb.endStep(s1, { topScore: sources[0]?.score ?? 0 });
    const s2 = tb.startStep('generation', { model: LLM_MODEL });
    tb.endStep(s2, { answerLength: answer.length });
    const trajectory = tb.complete(0.85);
    this.sona.recordTrajectory(trajectory);

    this.save();
    return memory.id;
  }

  // Find relevant past interactions using ONNX embedding similarity
  async findRelevant(queryEmbedding, k = 3) {
    if (this.memories.length === 0) return [];

    // Compute similarities against all stored memories
    const scored = this.memories.map((mem, i) => {
      if (!mem.embedding) return { index: i, score: 0 };
      const memEmb = new Float32Array(mem.embedding);
      let dot = 0, normA = 0, normB = 0;
      for (let j = 0; j < queryEmbedding.length; j++) {
        dot += queryEmbedding[j] * memEmb[j];
        normA += queryEmbedding[j] * queryEmbedding[j];
        normB += memEmb[j] * memEmb[j];
      }
      const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
      return { index: i, score: sim };
    });

    // Sort by similarity descending, take top k
    scored.sort((a, b) => b.score - a.score);
    const relevant = scored
      .slice(0, k)
      .filter(s => s.score > 0.5) // Only include if meaningfully similar
      .map(s => ({
        ...this.memories[s.index],
        similarity: s.score,
      }));

    return relevant;
  }

  // Get recent conversation history for context
  getRecentHistory(n = 6) {
    return this.history.slice(-n);
  }

  // Stats
  stats() {
    return {
      totalMemories: this.memories.length,
      historyMessages: this.history.length,
      sona: this.sona.stats(),
    };
  }
}

// ─── PDF Extraction ──────────────────────────────────────────

function extractPdfText(filePath) {
  const script = `
import pymupdf, json, sys
doc = pymupdf.open(sys.argv[1])
pages = []
for i, page in enumerate(doc):
    pages.append({"page": i + 1, "text": page.get_text()})
print(json.dumps({"numPages": len(pages), "pages": pages}))
`;
  const result = execSync(`python3 -c '${script}' "${filePath}"`, {
    maxBuffer: 50 * 1024 * 1024,
    encoding: 'utf-8',
  });
  return JSON.parse(result);
}

// ─── File Discovery ──────────────────────────────────────────

function findPdfs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...findPdfs(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      files.push(fullPath);
    }
  }
  return files;
}

// ─── Text Chunking (page-aware) ─────────────────────────────

function chunkPages(pages, maxChars = 1000, overlap = 200) {
  const segments = [];
  let fullText = '';
  for (const p of pages) {
    const cleaned = p.text.replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned.length === 0) continue;
    const start = fullText.length;
    fullText += (fullText.length > 0 ? '\n\n' : '') + cleaned;
    segments.push({ page: p.page, start, end: fullText.length });
  }

  if (fullText.length < 20) return [];

  const rawChunks = [];
  if (fullText.length <= maxChars) {
    rawChunks.push({ start: 0, end: fullText.length });
  } else {
    let start = 0;
    while (start < fullText.length) {
      let end = start + maxChars;
      if (end < fullText.length) {
        const slice = fullText.slice(start, end);
        const lastPara = slice.lastIndexOf('\n\n');
        const lastNewline = slice.lastIndexOf('\n');
        const lastSentence = slice.lastIndexOf('. ');
        if (lastPara > maxChars * 0.5) end = start + lastPara;
        else if (lastNewline > maxChars * 0.5) end = start + lastNewline;
        else if (lastSentence > maxChars * 0.5) end = start + lastSentence + 1;
      }
      rawChunks.push({ start, end: Math.min(end, fullText.length) });
      start = end - overlap;
    }
  }

  return rawChunks
    .map(c => {
      const text = fullText.slice(c.start, c.end).trim();
      if (text.length < 20) return null;
      const chunkPages = segments
        .filter(s => s.start < c.end && s.end > c.start)
        .map(s => s.page);
      return {
        text,
        pageStart: Math.min(...chunkPages),
        pageEnd: Math.max(...chunkPages),
      };
    })
    .filter(Boolean);
}

// ─── Knowledge Graph ─────────────────────────────────────────

// Financial domain entities to extract
const PRODUCT_TYPES = [
  'forward contract', 'fx swap', 'flexi forward', 'window forward',
  'bonus forward', 'enhanced forward', 'smart forward',
  'dual currency investment', 'foreign currency account',
  'foreign currency term deposit', 'term deposit',
  'business loan', 'agri loan', 'commercial loan',
  'interest rate swap', 'interest rate cap', 'interest rate collar',
  'option', 'put option', 'call option',
  'line of credit', 'overdraft', 'bill facility',
];

const FINANCIAL_CONCEPTS = [
  'margin call', 'settlement', 'early termination', 'rollover',
  'mark to market', 'credit risk', 'exchange rate risk', 'interest rate risk',
  'counterparty risk', 'liquidity risk', 'operational risk',
  'collateral', 'security', 'guarantee', 'indemnity',
  'hedging', 'speculation', 'netting', 'novation',
  'cooling off', 'disclosure', 'product information statement',
  'product disclosure statement', 'financial services guide',
  'dispute resolution', 'complaints', 'privacy',
  'fees and charges', 'break costs', 'establishment fee',
  'minimum balance', 'maturity date', 'expiry date',
  'notional amount', 'principal amount', 'face value',
  'spot rate', 'forward rate', 'strike price', 'premium',
];

const BRANDS = {
  'wbc': 'Westpac',
  'bom': 'Bank of Melbourne',
  'sgb': 'St.George Bank',
  'bsa': 'BankSA',
};

const CATEGORIES = {
  'fx': 'Foreign Exchange',
  'irrm': 'Interest Rate Risk Management',
  'deps': 'Deposits',
  'loans': 'Loans',
};

function extractEntities(text) {
  const lower = text.toLowerCase();
  const entities = new Set();

  for (const product of PRODUCT_TYPES) {
    if (lower.includes(product)) entities.add(`product:${product}`);
  }
  for (const concept of FINANCIAL_CONCEPTS) {
    if (lower.includes(concept)) entities.add(`concept:${concept}`);
  }

  return [...entities];
}

function extractDocMeta(filePath) {
  const parts = filePath.split('/');
  const meta = { brand: null, brandName: null, category: null, categoryName: null };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (BRANDS[lower]) {
      meta.brand = lower;
      meta.brandName = BRANDS[lower];
    }
    if (CATEGORIES[lower]) {
      meta.category = lower;
      meta.categoryName = CATEGORIES[lower];
    }
  }

  return meta;
}

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

class KnowledgeGraph {
  constructor() {
    // Nodes: id -> { type, label, meta }
    this.nodes = new Map();
    // Edges: source -> [{ target, type, weight }]
    this.edges = new Map();
    // Reverse index: entity -> [chunkId]
    this.entityIndex = new Map();
    // Doc -> [chunkId]
    this.docChunks = new Map();
  }

  addNode(id, type, label, meta = {}) {
    this.nodes.set(id, { type, label, meta });
    if (!this.edges.has(id)) this.edges.set(id, []);
  }

  addEdge(source, target, type, weight = 1.0) {
    if (!this.edges.has(source)) this.edges.set(source, []);
    // Avoid duplicate edges
    const existing = this.edges.get(source);
    if (!existing.find(e => e.target === target && e.type === type)) {
      existing.push({ target, type, weight });
    }
  }

  addBidirectional(a, b, type, weight = 1.0) {
    this.addEdge(a, b, type, weight);
    this.addEdge(b, a, type, weight);
  }

  getNeighbors(id, edgeType = null, maxDepth = 1) {
    const visited = new Set();
    const results = [];

    const traverse = (nodeId, depth) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);

      const edges = this.edges.get(nodeId) || [];
      for (const edge of edges) {
        if (edgeType && edge.type !== edgeType) continue;
        if (visited.has(edge.target)) continue;
        results.push({ id: edge.target, type: edge.type, weight: edge.weight, depth });
        traverse(edge.target, depth + 1);
      }
    };

    traverse(id, 0);
    return results;
  }

  // Build graph from ingested records
  buildFromRecords(records) {
    console.log('  Building knowledge graph...');

    // Create brand and category nodes
    for (const [code, name] of Object.entries(BRANDS)) {
      this.addNode(`brand:${code}`, 'brand', name);
    }
    for (const [code, name] of Object.entries(CATEGORIES)) {
      this.addNode(`category:${code}`, 'category', name);
    }

    // Process each record
    const filesSeen = new Set();
    for (const r of records) {
      // Chunk node
      this.addNode(r.id, 'chunk', r.preview?.slice(0, 80), {
        file: r.file, chunk: r.chunk, pageStart: r.pageStart, pageEnd: r.pageEnd,
      });

      // Document node (once per file)
      const docId = `doc:${r.file}`;
      if (!filesSeen.has(r.file)) {
        filesSeen.add(r.file);
        const docMeta = extractDocMeta(r.file);
        this.addNode(docId, 'document', r.file, docMeta);
        this.docChunks.set(r.file, []);

        // Link doc to brand and category
        if (docMeta.brand) {
          this.addBidirectional(docId, `brand:${docMeta.brand}`, 'belongs_to_brand');
        }
        if (docMeta.category) {
          this.addBidirectional(docId, `category:${docMeta.category}`, 'in_category');
        }
      }

      // Chunk -> Document
      this.addEdge(r.id, docId, 'part_of', 1.0);
      this.addEdge(docId, r.id, 'contains', 1.0);
      this.docChunks.get(r.file).push(r.id);

      // Extract entities from chunk text
      const entities = extractEntities(r.text || r.preview || '');
      for (const entity of entities) {
        // Create entity node if needed
        if (!this.nodes.has(entity)) {
          const [type, name] = entity.split(':');
          this.addNode(entity, type, name);
        }
        // Chunk <-> Entity
        this.addBidirectional(r.id, entity, 'mentions', 0.8);

        // Track entity -> chunks for co-occurrence
        if (!this.entityIndex.has(entity)) this.entityIndex.set(entity, []);
        this.entityIndex.get(entity).push(r.id);
      }
    }

    // Build co-occurrence edges: chunks sharing entities
    for (const [entity, chunkIds] of this.entityIndex) {
      if (chunkIds.length > 1 && chunkIds.length < 50) {
        // Connect chunks that share niche entities (skip very common ones)
        for (let i = 0; i < chunkIds.length; i++) {
          for (let j = i + 1; j < chunkIds.length; j++) {
            // Only cross-document co-occurrence is interesting
            const fileA = this.nodes.get(chunkIds[i])?.meta?.file;
            const fileB = this.nodes.get(chunkIds[j])?.meta?.file;
            if (fileA !== fileB) {
              this.addBidirectional(chunkIds[i], chunkIds[j], 'shared_concept', 0.5);
            }
          }
        }
      }
    }

    // Build semantic similarity edges between chunk embeddings
    // (only between chunks from different documents, top similarities)
    console.log('  Computing cross-document similarities...');
    const SIM_THRESHOLD = 0.85;
    let simEdges = 0;

    // Group by file for cross-doc comparison
    const byFile = new Map();
    for (const r of records) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    const fileList = [...byFile.keys()];

    // Sample-based: compare first/last chunks between documents
    for (let i = 0; i < fileList.length; i++) {
      const chunksA = byFile.get(fileList[i]);
      // Take representative chunks (first, middle, last)
      const repsA = [
        chunksA[0],
        chunksA[Math.floor(chunksA.length / 2)],
        chunksA[chunksA.length - 1],
      ].filter(Boolean);

      for (let j = i + 1; j < fileList.length; j++) {
        const chunksB = byFile.get(fileList[j]);
        const repsB = [
          chunksB[0],
          chunksB[Math.floor(chunksB.length / 2)],
          chunksB[chunksB.length - 1],
        ].filter(Boolean);

        for (const a of repsA) {
          for (const b of repsB) {
            const sim = cosineSim(a.embedding, b.embedding);
            if (sim > SIM_THRESHOLD) {
              this.addBidirectional(a.id, b.id, 'semantically_similar', sim);
              simEdges++;
            }
          }
        }
      }
    }

    // Stats
    let totalEdges = 0;
    for (const edges of this.edges.values()) totalEdges += edges.length;
    const entityCount = [...this.nodes.values()].filter(n => n.type === 'product' || n.type === 'concept').length;

    console.log(`  Graph built:`);
    console.log(`    ${this.nodes.size} nodes (${filesSeen.size} docs, ${records.length} chunks, ${entityCount} entities)`);
    console.log(`    ${totalEdges} edges (${simEdges} similarity links)`);
  }

  // Graph-enhanced search — returns { results, path }
  expandResults(vectorResults, allRecords, k = 10) {
    const resultIds = new Set(vectorResults.map(r => r.id));
    const scored = new Map();

    // Track traversal path for visualization
    const pathNodes = new Set();   // node IDs visited
    const pathEdges = [];          // { source, target, type } edges traversed

    // Score initial vector results
    for (const r of vectorResults) {
      scored.set(r.id, {
        vectorScore: r.score,
        graphScore: 0,
        sources: ['vector'],
        ...r,
      });
      // Track: chunk → document
      pathNodes.add(r.id);
      if (r.file) {
        const docId = `doc:${r.file}`;
        pathNodes.add(docId);
        pathEdges.push({ source: r.id, target: docId, type: 'part_of' });

        // Track: document → brand/category
        const meta = extractDocMeta(r.file);
        if (meta.brand) {
          const brandId = `brand:${meta.brand}`;
          pathNodes.add(brandId);
          pathEdges.push({ source: docId, target: brandId, type: 'belongs_to_brand' });
        }
        if (meta.category) {
          const catId = `category:${meta.category}`;
          pathNodes.add(catId);
          pathEdges.push({ source: docId, target: catId, type: 'in_category' });
        }
      }
    }

    // For each vector result, traverse graph to find related chunks
    for (const r of vectorResults) {
      const neighbors = this.getNeighbors(r.id, null, 2);

      for (const neighbor of neighbors) {
        if (neighbor.id.startsWith('brand:') || neighbor.id.startsWith('category:')) continue;
        if (neighbor.id.startsWith('doc:')) continue;

        // Only care about chunk neighbors
        const node = this.nodes.get(neighbor.id);
        if (!node || node.type !== 'chunk') continue;

        const weight = neighbor.weight * (neighbor.depth === 0 ? 1.0 : 0.5);

        // Track traversal edge
        pathNodes.add(neighbor.id);
        pathEdges.push({ source: r.id, target: neighbor.id, type: neighbor.type });

        // Track any entity intermediaries (the hop through shared concepts)
        if (neighbor.depth > 0) {
          // Find entity nodes that connect these chunks
          const sourceEdges = this.edges.get(r.id) || [];
          for (const e of sourceEdges) {
            const eNode = this.nodes.get(e.target);
            if (eNode && (eNode.type === 'product' || eNode.type === 'concept')) {
              const entityEdges = this.edges.get(e.target) || [];
              if (entityEdges.some(ee => ee.target === neighbor.id)) {
                pathNodes.add(e.target);
                pathEdges.push({ source: r.id, target: e.target, type: 'mentions' });
                pathEdges.push({ source: e.target, target: neighbor.id, type: 'mentions' });
              }
            }
          }
        }

        if (scored.has(neighbor.id)) {
          // Boost existing result
          const existing = scored.get(neighbor.id);
          existing.graphScore += weight;
          if (!existing.sources.includes(neighbor.type)) {
            existing.sources.push(neighbor.type);
          }
        } else {
          // Add graph-discovered result
          const record = allRecords.find(rec => rec.id === neighbor.id);
          if (record) {
            scored.set(neighbor.id, {
              id: neighbor.id,
              vectorScore: 2.0, // high distance = not in vector results
              graphScore: weight,
              sources: [neighbor.type],
              file: record.file,
              chunk: record.chunk,
              totalChunks: record.totalChunks,
              pages: record.pages,
              pageStart: record.pageStart,
              pageEnd: record.pageEnd,
              preview: record.preview,
              text: record.text,
            });

            // Track graph-discovered chunk's document
            if (record.file) {
              const docId = `doc:${record.file}`;
              pathNodes.add(docId);
              pathEdges.push({ source: neighbor.id, target: docId, type: 'part_of' });
            }
          }
        }
      }
    }

    // Combined scoring: lower is better
    const combined = [...scored.values()]
      .map(r => ({
        ...r,
        combinedScore: r.vectorScore - (r.graphScore * 0.15),
      }))
      .sort((a, b) => a.combinedScore - b.combinedScore)
      .slice(0, k);

    // Deduplicate path edges
    const edgeSet = new Set();
    const uniquePathEdges = pathEdges.filter(e => {
      const key = `${e.source}|${e.target}|${e.type}`;
      if (edgeSet.has(key)) return false;
      edgeSet.add(key);
      return true;
    });

    return {
      results: combined,
      path: { nodes: [...pathNodes], edges: uniquePathEdges },
    };
  }

  // Serialize
  toJSON() {
    return {
      nodes: [...this.nodes.entries()],
      edges: [...this.edges.entries()],
      entityIndex: [...this.entityIndex.entries()],
      docChunks: [...this.docChunks.entries()],
    };
  }

  static fromJSON(data) {
    const g = new KnowledgeGraph();
    g.nodes = new Map(data.nodes);
    g.edges = new Map(data.edges);
    g.entityIndex = new Map(data.entityIndex);
    g.docChunks = new Map(data.docChunks);
    return g;
  }
}

// ─── Index Persistence ───────────────────────────────────────

function saveIndex(records, dim, graph) {
  if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });

  const meta = records.map(r => ({
    id: r.id, file: r.file, chunk: r.chunk, totalChunks: r.totalChunks,
    pages: r.pages, preview: r.preview, text: r.text,
    pageStart: r.pageStart, pageEnd: r.pageEnd, mtime: r.mtime || 0,
  }));
  fs.writeFileSync(META_FILE, JSON.stringify({ dim, count: records.length, records: meta }, null, 2));

  const buffer = Buffer.alloc(records.length * dim * 4);
  for (let i = 0; i < records.length; i++) {
    for (let j = 0; j < dim; j++) {
      buffer.writeFloatLE(records[i].embedding[j], (i * dim + j) * 4);
    }
  }
  fs.writeFileSync(EMBEDDINGS_FILE, buffer);

  // Save graph
  if (graph) {
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph.toJSON()));
  }

  console.log(`\nIndex saved to ${INDEX_DIR}/`);
  console.log(`  metadata.json: ${(fs.statSync(META_FILE).size / 1024).toFixed(0)} KB`);
  console.log(`  embeddings.bin: ${(fs.statSync(EMBEDDINGS_FILE).size / 1024 / 1024).toFixed(1)} MB`);
  if (graph && fs.existsSync(GRAPH_FILE)) {
    console.log(`  graph.json: ${(fs.statSync(GRAPH_FILE).size / 1024).toFixed(0)} KB`);
  }
}

function loadIndex() {
  if (!fs.existsSync(META_FILE) || !fs.existsSync(EMBEDDINGS_FILE)) return null;

  const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  const buffer = fs.readFileSync(EMBEDDINGS_FILE);
  const dim = meta.dim;

  const records = meta.records.map((r, i) => {
    const embedding = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      embedding[j] = buffer.readFloatLE((i * dim + j) * 4);
    }
    return { ...r, embedding };
  });

  let graph = null;
  if (fs.existsSync(GRAPH_FILE)) {
    graph = KnowledgeGraph.fromJSON(JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf-8')));
  }

  return { dim, records, graph };
}

// ─── Fast Vector Search (brute-force, no DB overhead) ────────

function vectorSearch(queryVec, records, k) {
  // Brute-force cosine distance — faster than 6220 async inserts
  // At 384d × 6220 records this takes <50ms in pure JS
  const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
  
  const scored = new Float64Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const emb = records[i].embedding;
    let dot = 0, norm = 0;
    for (let j = 0; j < queryVec.length; j++) {
      dot += queryVec[j] * emb[j];
      norm += emb[j] * emb[j];
    }
    // cosine distance (lower = more similar, matches NativeVectorDb behavior)
    scored[i] = 1 - (dot / (queryNorm * Math.sqrt(norm) + 1e-8));
  }

  // Partial sort: find top-k indices
  const indices = Array.from({ length: records.length }, (_, i) => i);
  indices.sort((a, b) => scored[a] - scored[b]);

  return indices.slice(0, k).map(i => ({
    id: records[i].id,
    score: scored[i],
    record: records[i],
  }));
}

// ─── Display ─────────────────────────────────────────────────

function formatResult(r, i, showGraph = false) {
  const meta = r.file ? r : JSON.parse(r.metadata || '{}');
  const score = (r.combinedScore ?? r.score ?? r.vectorScore ?? 0).toFixed(4);
  const pageLabel = meta.pageStart === meta.pageEnd
    ? `p.${meta.pageStart}` : `pp.${meta.pageStart}-${meta.pageEnd}`;

  let header = `  ${i + 1}. [${score}] ${meta.file} (${pageLabel})`;

  if (showGraph && r.sources) {
    const tags = r.sources.filter(s => s !== 'vector');
    if (tags.length > 0) {
      header += `  ← graph: ${tags.join(', ')}`;
    }
    if (r.graphScore > 0) {
      header += ` [+${r.graphScore.toFixed(2)} boost]`;
    }
  }

  const text = meta.text || meta.preview || '';
  return `${header}\n     ${text}\n`;
}

// ─── LLM / RAG ──────────────────────────────────────────────

function formatContext(results) {
  return results.map((r, i) => {
    const meta = r.file ? r : {};
    const pageLabel = meta.pageStart === meta.pageEnd
      ? `page ${meta.pageStart}` : `pages ${meta.pageStart}-${meta.pageEnd}`;
    const source = `[Source ${i + 1}: ${meta.file || 'unknown'}, ${pageLabel}]`;
    const text = meta.text || meta.preview || '';
    return `${source}\n${text}`;
  }).join('\n\n---\n\n');
}

const RAG_SYSTEM_PROMPT = `You are a knowledgeable financial document assistant. You answer questions based on the provided source documents and conversation history.

Brand context:
The documents come from four separate banking brands under the Westpac Group. You can identify them from the file paths:
- WBC = Westpac (the parent brand)
- SGB / STG = St.George Bank
- BSA = BankSA
- BOM = Bank of Melbourne
These are separate brands with separate products and terms. Differences between them are expected and normal — not contradictions. Always attribute information to the correct brand by name.

Rules:
- Answer the question using the information in the sources provided below.
- Cite your sources using [Source N] notation inline.
- When sources from different brands give different information, present each brand's position clearly rather than calling it a discrepancy.
- If previous conversation context is provided, use it to understand follow-up questions and maintain continuity.
- If the sources don't contain enough information to fully answer, say what you can and note what's missing.
- Be precise with financial terms, amounts, dates, and conditions.
- Keep your answer clear and well-structured.
- Do not make up information that isn't in the sources.`;

async function callLLM(messages, { stream = true } = {}) {
  if (!LLM_API_KEY) {
    throw new Error('OPENAI_API_KEY not set. Export it: export OPENAI_API_KEY=sk-...');
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream,
      temperature: 0.2,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error (${response.status}): ${err.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // Stream response token by token
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content || '';
        if (token) {
          process.stdout.write(token);
          fullResponse += token;
        }
      } catch (e) {
        // skip malformed chunks
      }
    }
  }

  return fullResponse;
}

async function ragAnswer(query, results, memory = null) {
  const context = formatContext(results);

  // Show sources summary
  console.log('\n  Sources:');
  results.forEach((r, i) => {
    const meta = r.file ? r : {};
    const pageLabel = meta.pageStart === meta.pageEnd
      ? `p.${meta.pageStart}` : `pp.${meta.pageStart}-${meta.pageEnd}`;
    const score = (r.combinedScore ?? r.score ?? r.vectorScore ?? 0).toFixed(4);
    console.log(`    [${i + 1}] ${meta.file || 'unknown'} (${pageLabel}) [${score}]`);
  });

  // Build conversation context from memory
  let memoryContext = '';
  let historyMessages = [];
  let queryEmb = null;

  if (memory) {
    const queryResult = await rv.embed(query);
    queryEmb = new Float32Array(queryResult.embedding);
    const pastInteractions = await memory.findRelevant(queryEmb, 3);

    if (pastInteractions.length > 0) {
      console.log('\n  Relevant past interactions:');
      pastInteractions.forEach((m, i) => {
        console.log(`    [memory ${i + 1}] "${m.query}" (sim: ${m.similarity.toFixed(2)})`);
      });

      memoryContext = '\n\nRelevant past interactions:\n' +
        pastInteractions.map((m, i) =>
          `[Past Q${i + 1}]: ${m.query}\n[Past A${i + 1}]: ${m.answer}`
        ).join('\n\n');
    }

    // Get recent conversation history
    const recent = memory.getRecentHistory(6);
    if (recent.length > 0) {
      historyMessages = recent.map(h => ({
        role: h.role,
        content: h.content,
      }));
    }
  }

  console.log('\n  Answer:\n');

  const messages = [
    { role: 'system', content: RAG_SYSTEM_PROMPT },
    ...historyMessages,
    { role: 'user', content: `Sources:\n\n${context}${memoryContext}\n\n---\n\nQuestion: ${query}` },
  ];

  const answer = await callLLM(messages);
  console.log('\n');

  // Store interaction in memory (reuse embedding)
  if (memory && queryEmb) {
    await memory.store(query, answer, results, queryEmb);
  }

  return answer;
}

// Query rewriting: expand follow-up questions into standalone search queries
async function rewriteQuery(query, memory) {
  if (!memory || !LLM_API_KEY) return query;

  const recent = memory.getRecentHistory(4);
  if (recent.length === 0) return query;

  // Only rewrite if the query looks like a follow-up (short or contains referential language)
  const followUpSignals = /^(what about|how about|and for|i meant|same for|that|this|it|they|those|the same|compared to|versus|vs|but for)/i;
  const isShort = query.split(/\s+/).length < 8;

  if (!isShort && !followUpSignals.test(query)) return query;

  const historyText = recent.map(h => `${h.role}: ${h.content}`).join('\n');

  try {
    const rewritten = await callLLM([
      {
        role: 'system',
        content: `You rewrite follow-up questions into standalone search queries.
Given a conversation history and a follow-up question, output ONLY the rewritten query — nothing else.
The rewritten query must be self-contained and specific enough to retrieve the right documents.
Do not explain, do not add quotes, just output the query text.`,
      },
      {
        role: 'user',
        content: `Conversation:\n${historyText}\n\nFollow-up: ${query}\n\nRewritten query:`,
      },
    ], { stream: false });

    const cleaned = rewritten.trim().replace(/^["']|["']$/g, '');
    if (cleaned && cleaned.length > 3 && cleaned.length < 200) {
      console.log(`  Query rewritten: "${query}" → "${cleaned}"`);
      return cleaned;
    }
  } catch (e) {
    // Fall through to original query on error
  }

  return query;
}

// Shared retrieval function used by search, ask, and interactive
async function retrieve(query, index, { k = 5, graphMode = true, memory = null } = {}) {
  // Rewrite follow-up queries into standalone search queries
  const searchQuery = await rewriteQuery(query, memory);

  const hasGraph = !!index.graph;
  const result = await rv.embed(searchQuery);
  const queryVec = new Float32Array(result.embedding);
  const vectorK = hasGraph && graphMode ? Math.max(k, 10) : k;
  const vectorResults = vectorSearch(queryVec, index.records, vectorK);

  const parsed = vectorResults.map(r => ({
    ...r.record, id: r.id, score: r.score, vectorScore: r.score,
  }));

  if (hasGraph && graphMode) {
    const { results, path } = index.graph.expandResults(parsed, index.records, k);
    return { results, path, mode: 'vector+graph' };
  }
  return { results: parsed.slice(0, k), path: null, mode: 'vector' };
}

// ─── Commands ────────────────────────────────────────────────

async function ingest() {
  console.log('Initializing ONNX embedder...');
  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();
  console.log(`ONNX ready: ${dim}d\n`);

  const files = findPdfs(DOCS_DIR);
  console.log(`Found ${files.length} PDFs in ${DOCS_DIR}\n`);

  if (files.length === 0) { console.log('No PDFs found.'); return; }

  const records = [];
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relPath = path.relative(DOCS_DIR, filePath);

    try {
      const pdf = extractPdfText(filePath);
      const mtime = fs.statSync(filePath).mtimeMs;
      const allText = pdf.pages.map(p => p.text).join(' ').trim();
      if (allText.length < 20) {
        console.log(`  SKIP ${relPath}: no extractable text`);
        errors++;
        continue;
      }

      const chunks = chunkPages(pdf.pages);

      for (let j = 0; j < chunks.length; j++) {
        const result = await rv.embed(chunks[j].text);
        records.push({
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: pdf.numPages, pageStart: chunks[j].pageStart, pageEnd: chunks[j].pageEnd,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          mtime, embedding: new Float32Array(result.embedding),
        });
      }

      const pct = ((i + 1) / files.length * 100).toFixed(0);
      console.log(`  [${pct}%] ${relPath} — ${pdf.numPages} pages, ${chunks.length} chunks`);

    } catch (e) {
      console.log(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`PDFs processed: ${files.length - errors}/${files.length}`);
  console.log(`Total chunks: ${records.length}`);

  // Build knowledge graph
  console.log(`\n=== Building Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records);

  saveIndex(records, dim, graph);
}

async function update() {
  const index = loadIndex();
  if (!index) {
    console.log('No existing index found. Running full ingest instead.\n');
    return ingest();
  }

  console.log('Initializing ONNX embedder...');
  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();
  console.log(`ONNX ready: ${dim}d\n`);

  const currentFiles = findPdfs(DOCS_DIR);
  const currentRelPaths = new Set(currentFiles.map(f => path.relative(DOCS_DIR, f)));

  const indexedFiles = new Map();
  for (const r of index.records) {
    if (!indexedFiles.has(r.file)) indexedFiles.set(r.file, r.mtime || 0);
  }

  const toAdd = [];
  const toUpdate = [];
  const toRemove = new Set();

  for (const filePath of currentFiles) {
    const relPath = path.relative(DOCS_DIR, filePath);
    const currentMtime = fs.statSync(filePath).mtimeMs;
    if (!indexedFiles.has(relPath)) toAdd.push(filePath);
    else if (currentMtime > indexedFiles.get(relPath)) toUpdate.push(filePath);
  }

  for (const indexedFile of indexedFiles.keys()) {
    if (!currentRelPaths.has(indexedFile)) toRemove.add(indexedFile);
  }

  console.log(`Index: ${indexedFiles.size} files, ${index.records.length} chunks`);
  console.log(`New: ${toAdd.length} · Modified: ${toUpdate.length} · Deleted: ${toRemove.size}`);

  if (toAdd.length === 0 && toUpdate.length === 0 && toRemove.size === 0) {
    console.log('\nIndex is up to date.');
    return;
  }

  const removeFiles = new Set([...toRemove, ...toUpdate.map(f => path.relative(DOCS_DIR, f))]);
  let records = index.records.filter(r => !removeFiles.has(r.file));
  const removedChunks = index.records.length - records.length;

  const filesToProcess = [...toAdd, ...toUpdate];
  let newChunks = 0;
  let errors = 0;

  for (let i = 0; i < filesToProcess.length; i++) {
    const filePath = filesToProcess[i];
    const relPath = path.relative(DOCS_DIR, filePath);

    try {
      const pdf = extractPdfText(filePath);
      const mtime = fs.statSync(filePath).mtimeMs;
      const allText = pdf.pages.map(p => p.text).join(' ').trim();
      if (allText.length < 20) { errors++; continue; }

      const chunks = chunkPages(pdf.pages);

      for (let j = 0; j < chunks.length; j++) {
        const result = await rv.embed(chunks[j].text);
        records.push({
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: pdf.numPages, pageStart: chunks[j].pageStart, pageEnd: chunks[j].pageEnd,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          mtime, embedding: new Float32Array(result.embedding),
        });
        newChunks++;
      }

      const label = toAdd.includes(filePath) ? 'NEW' : 'UPDATED';
      const pct = ((i + 1) / filesToProcess.length * 100).toFixed(0);
      console.log(`  [${pct}%] [${label}] ${relPath} — ${pdf.numPages} pages, ${chunks.length} chunks`);

    } catch (e) {
      console.log(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  console.log(`\n=== Update Complete ===`);
  console.log(`Removed: ${removedChunks} chunks · Added: ${newChunks} chunks · Total: ${records.length}`);

  // Rebuild graph from all records
  console.log(`\n=== Rebuilding Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records);

  saveIndex(records, dim, graph);
}

async function search(query, k = 5, graphMode = true) {
  const index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const hasGraph = !!index.graph;
  console.log(`Loading index: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);

  await rv.initOnnxEmbedder();

  const { results, mode } = await retrieve(query, index, { k, graphMode });
  console.log(`\nResults for: "${query}" (${mode})\n`);
  results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph)));
}

async function ask(query, k = 8) {
  const index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const hasGraph = !!index.graph;
  console.log(`Loading index: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  console.log(`LLM: ${LLM_MODEL} via ${LLM_BASE_URL}\n`);

  await rv.initOnnxEmbedder();

  // Load conversation memory
  const memory = new ConversationMemory();
  memory.load();

  console.log(`Retrieving context for: "${query}"`);
  const { results } = await retrieve(query, index, { k, graphMode: true, memory });

  await ragAnswer(query, results, memory);
}

async function interactive() {
  const index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const hasGraph = !!index.graph;
  const hasLLM = !!LLM_API_KEY;
  console.log(`Loading index: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  if (hasLLM) console.log(`LLM: ${LLM_MODEL} via ${LLM_BASE_URL}`);
  else console.log(`LLM: not configured (set OPENAI_API_KEY for RAG answers)`);

  await rv.initOnnxEmbedder();

  // Load conversation memory
  const memory = new ConversationMemory();
  memory.load();

  const uniqueFiles = new Set(index.records.map(r => r.file)).size;
  console.log(`\nReady. ${index.records.length} chunks from ${uniqueFiles} PDFs.`);
  if (hasGraph) {
    const entityCount = [...index.graph.nodes.values()].filter(
      n => n.type === 'product' || n.type === 'concept'
    ).length;
    console.log(`Knowledge graph: ${index.graph.nodes.size} nodes, ${entityCount} entities.`);
  }
  if (memory.memories.length > 0) {
    console.log(`Conversation memory: ${memory.memories.length} past interactions.`);
  }

  console.log('\nCommands:');
  if (hasLLM) {
    console.log('  <query>             Ask a question (RAG + memory)');
    console.log('  --search <query>    Show raw search results (no LLM)');
  } else {
    console.log('  <query>             Search with graph expansion');
  }
  console.log('  --flat <query>      Search without graph (vector only)');
  console.log('  --k N <query>       Return N results');
  console.log('  --related <file>    Show documents related to a file');
  console.log('  --entities          List discovered entities');
  console.log('  --memory            Show conversation memory stats');
  console.log('  --forget            Clear conversation memory');
  console.log('  quit                Exit\n');

  const prompt = hasLLM ? 'ask> ' : 'search> ';
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt,
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input || input === 'quit' || input === 'exit') { rl.close(); return; }

    try {
      // --entities: list all discovered entities
      if (input === '--entities') {
        if (!hasGraph) { console.log('No graph available.\n'); rl.prompt(); return; }
        const products = [];
        const concepts = [];
        for (const [id, node] of index.graph.nodes) {
          if (node.type === 'product') products.push(node.label);
          if (node.type === 'concept') concepts.push(node.label);
        }
        console.log(`\nProducts (${products.length}): ${products.sort().join(', ')}`);
        console.log(`\nConcepts (${concepts.length}): ${concepts.sort().join(', ')}\n`);
        rl.prompt(); return;
      }

      // --memory: show memory stats
      if (input === '--memory') {
        const stats = memory.stats();
        console.log(`\n  Conversation Memory:`);
        console.log(`    Past interactions: ${stats.totalMemories}`);
        console.log(`    History messages: ${stats.historyMessages}`);
        console.log(`    SONA trajectories buffered: ${stats.sona.trajectoriesBuffered}`);
        console.log(`    SONA patterns learned: ${stats.sona.patterns.totalPatterns}`);
        if (memory.memories.length > 0) {
          console.log(`\n  Recent queries:`);
          memory.memories.slice(-5).forEach((m, i) => {
            const ts = new Date(m.timestamp).toLocaleTimeString();
            console.log(`    [${ts}] ${m.query}`);
          });
        }
        console.log();
        rl.prompt(); return;
      }

      // --forget: clear memory
      if (input === '--forget') {
        memory.history = [];
        memory.memories = [];
        memory.reasoningBank = new ReasoningBank();
        memory.sona = new SonaCoordinator();
        memory.save();
        console.log('\n  Memory cleared.\n');
        rl.prompt(); return;
      }

      // --related <file>: show related documents
      if (input.startsWith('--related ')) {
        if (!hasGraph) { console.log('No graph available.\n'); rl.prompt(); return; }
        const fileQuery = input.slice(10).trim();
        const matchingFiles = [...index.graph.docChunks.keys()].filter(
          f => f.toLowerCase().includes(fileQuery.toLowerCase())
        );
        if (matchingFiles.length === 0) {
          console.log(`No files matching "${fileQuery}"\n`);
          rl.prompt(); return;
        }
        const file = matchingFiles[0];
        console.log(`\nRelated to: ${file}\n`);

        const docId = `doc:${file}`;
        const neighbors = index.graph.getNeighbors(docId, null, 2);

        const related = { documents: new Set(), products: new Set(), concepts: new Set(), brands: new Set() };
        for (const n of neighbors) {
          const node = index.graph.nodes.get(n.id);
          if (!node) continue;
          if (node.type === 'document') related.documents.add(node.label);
          else if (node.type === 'product') related.products.add(node.label);
          else if (node.type === 'concept') related.concepts.add(node.label);
          else if (node.type === 'brand') related.brands.add(node.label);
        }

        if (related.brands.size) console.log(`  Brand: ${[...related.brands].join(', ')}`);
        if (related.products.size) console.log(`  Products: ${[...related.products].join(', ')}`);
        if (related.concepts.size) console.log(`  Concepts: ${[...related.concepts].join(', ')}`);
        if (related.documents.size > 1) {
          console.log(`  Related docs:`);
          for (const d of [...related.documents].filter(d => d !== file).slice(0, 10)) {
            console.log(`    - ${d}`);
          }
        }
        console.log();
        rl.prompt(); return;
      }

      // Parse flags
      let k = hasLLM ? 8 : 5;
      let graphMode = true;
      let searchOnly = false;
      let searchQuery = input;

      const kMatch = input.match(/--k\s+(\d+)/);
      if (kMatch) {
        k = parseInt(kMatch[1]);
        searchQuery = searchQuery.replace(/--k\s+\d+/, '').trim();
      }
      if (searchQuery.startsWith('--flat ')) {
        graphMode = false;
        searchQuery = searchQuery.slice(7).trim();
      }
      if (searchQuery.startsWith('--search ')) {
        searchOnly = true;
        searchQuery = searchQuery.slice(9).trim();
      }

      // Retrieve (pass memory for query rewriting on follow-ups)
      const useMemory = hasLLM && !searchOnly ? memory : null;
      const { results, mode } = await retrieve(searchQuery, index, { k, graphMode, memory: useMemory });

      if (!hasLLM || searchOnly) {
        // Raw search results
        console.log(`\n  [${mode}]\n`);
        results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph && graphMode)));
      } else {
        // RAG with memory
        await ragAnswer(searchQuery, results, memory);
      }

    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => { console.log('\nBye.'); process.exit(0); });
}

async function stats() {
  const index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const files = new Map();
  for (const r of index.records) {
    if (!files.has(r.file)) files.set(r.file, { chunks: 0, pages: r.pages });
    files.get(r.file).chunks++;
  }

  console.log(`\n=== Index Statistics ===`);
  console.log(`Total PDFs: ${files.size}`);
  console.log(`Total chunks: ${index.records.length}`);
  console.log(`Embedding dimensions: ${index.dim}`);
  console.log(`Index size: ${(fs.statSync(EMBEDDINGS_FILE).size / 1024 / 1024).toFixed(1)} MB`);

  if (index.graph) {
    const g = index.graph;
    let totalEdges = 0;
    for (const edges of g.edges.values()) totalEdges += edges.length;

    const nodeTypes = {};
    for (const node of g.nodes.values()) {
      nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
    }

    console.log(`\n=== Knowledge Graph ===`);
    console.log(`Nodes: ${g.nodes.size}`);
    for (const [type, count] of Object.entries(nodeTypes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type}: ${count}`);
    }
    console.log(`Edges: ${totalEdges}`);
    console.log(`Entities tracked: ${g.entityIndex.size}`);
    console.log(`Graph file: ${(fs.statSync(GRAPH_FILE).size / 1024).toFixed(0)} KB`);
  }

  const dirs = new Map();
  for (const [file, info] of files) {
    const dir = file.split('/').slice(0, 2).join('/');
    if (!dirs.has(dir)) dirs.set(dir, { files: 0, chunks: 0 });
    dirs.get(dir).files++;
    dirs.get(dir).chunks += info.chunks;
  }

  console.log(`\nBy directory:`);
  for (const [dir, info] of [...dirs.entries()].sort((a, b) => b[1].chunks - a[1].chunks)) {
    console.log(`  ${dir}: ${info.files} files, ${info.chunks} chunks`);
  }

  // Memory stats
  if (fs.existsSync(MEMORY_FILE)) {
    try {
      const memData = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
      console.log(`\n=== Conversation Memory ===`);
      console.log(`Past interactions: ${(memData.memories || []).length}`);
      console.log(`History messages: ${(memData.history || []).length}`);
      console.log(`Memory file: ${(fs.statSync(MEMORY_FILE).size / 1024).toFixed(0)} KB`);
    } catch (e) {}
  }
}

// ─── Web Server ─────────────────────────────────────────────

async function serve(port = 3000) {
  const index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  console.log(`Loading index: ${index.records.length} chunks, ${index.dim}d${index.graph ? ' + graph' : ''}`);
  await rv.initOnnxEmbedder();

  const memory = new ConversationMemory();
  memory.load();

  // Build graph viz data (same as gen-viz.js)
  const vizData = buildVizData(index.graph);

  // Read HTML template
  const htmlPath = path.join(__dirname, 'graph-viz.html');
  if (!fs.existsSync(htmlPath)) {
    console.log('graph-viz.html not found in project root. Cannot serve.');
    return;
  }

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      // Serve HTML with embedded graph data and chat panel
      let html = fs.readFileSync(htmlPath, 'utf-8');
      const dataJson = JSON.stringify(vizData);
      html = html.replace(
        'tryLoadData();',
        `initGraph(${dataJson});document.getElementById('loading').classList.add('hidden');`
      );
      // Inject chat panel
      html = html.replace('</body>', CHAT_PANEL_HTML + '</body>');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ask') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { query } = JSON.parse(body);
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing query' }));
            return;
          }

          console.log(`[ask] ${query}`);

          const { results, path: graphPath, mode } = await retrieve(query, index, { k: 8, graphMode: true, memory });

          // Get answer from LLM (non-streaming)
          const context = formatContext(results);
          let memoryContext = '';
          const queryResult = await rv.embed(query);
          const queryEmb = new Float32Array(queryResult.embedding);
          const pastInteractions = await memory.findRelevant(queryEmb, 3);
          if (pastInteractions.length > 0) {
            memoryContext = '\n\nRelevant past interactions:\n' +
              pastInteractions.map((m, i) =>
                `[Past Q${i + 1}]: ${m.query}\n[Past A${i + 1}]: ${m.answer}`
              ).join('\n\n');
          }
          const historyMessages = memory.getRecentHistory(6).map(h => ({
            role: h.role, content: h.content,
          }));

          const messages = [
            { role: 'system', content: RAG_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: `Sources:\n\n${context}${memoryContext}\n\n---\n\nQuestion: ${query}` },
          ];

          const answer = await callLLM(messages, { stream: false });

          // Store in memory
          await memory.store(query, answer, results, queryEmb);

          // Build sources summary
          const sources = results.map((r, i) => ({
            index: i + 1,
            file: r.file,
            pageStart: r.pageStart,
            pageEnd: r.pageEnd,
            score: (r.combinedScore ?? r.score ?? r.vectorScore ?? 0),
          }));

          // Map chunk IDs to document IDs for viz (chunks aren't in viz)
          function chunkToDoc(id) {
            const node = index.graph?.nodes.get(id);
            if (node && node.type === 'chunk') {
              const rec = index.records.find(r => r.id === id);
              return rec ? `doc:${rec.file}` : null;
            }
            return id; // already a doc/brand/category/entity ID
          }

          const vizPath = graphPath ? {
            nodes: [...new Set(
              graphPath.nodes
                .map(id => chunkToDoc(id))
                .filter(Boolean)
            )],
            edges: graphPath.edges
              .map(e => ({
                source: chunkToDoc(e.source),
                target: chunkToDoc(e.target),
                type: e.type,
              }))
              .filter(e => e.source && e.target && e.source !== e.target),
          } : null;

          // Deduplicate viz path edges
          if (vizPath) {
            const edgeSet = new Set();
            vizPath.edges = vizPath.edges.filter(e => {
              const k = `${e.source}|${e.target}`;
              if (edgeSet.has(k)) return false;
              edgeSet.add(k);
              return true;
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (vizPath) {
            console.log(`  Path: ${vizPath.nodes.length} nodes, ${vizPath.edges.length} edges`);
            console.log(`  Path nodes: ${vizPath.nodes.slice(0, 8).join(', ')}${vizPath.nodes.length > 8 ? '...' : ''}`);
          }
          res.end(JSON.stringify({ answer, sources, path: vizPath, mode }));

        } catch (e) {
          console.error('[ask error]', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/forget') {
      memory.history = [];
      memory.memories = [];
      memory.reasoningBank = new ReasoningBank();
      memory.sona = new SonaCoordinator();
      memory.save();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`\n  Graph + Chat server running at http://localhost:${port}`);
    console.log(`  LLM: ${LLM_MODEL} via ${LLM_BASE_URL}\n`);
  });
}

function buildVizData(graph) {
  if (!graph) return { nodes: [], edges: [] };

  const vizNodes = [];
  const vizNodeIds = new Set();

  for (const [id, node] of graph.nodes) {
    if (node.type === 'chunk') continue;
    vizNodes.push({ id, type: node.type, label: node.label, meta: node.meta || {} });
    vizNodeIds.add(id);
  }

  const edgeMap = new Map(); // key -> { source, target, type, weight }

  function addEdge(source, target, type, weight) {
    if (!vizNodeIds.has(source) || !vizNodeIds.has(target)) return;
    if (source === target) return;
    const key = `${source}|${target}|${type}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight = (existing.weight || 1) + (weight || 1); // accumulate weight
    } else {
      edgeMap.set(key, { source, target, type, weight: weight || 1 });
    }
  }

  function findDocForChunk(chunkId) {
    for (const [file, chunks] of graph.docChunks) {
      if (chunks.includes(chunkId)) return `doc:${file}`;
    }
    return null;
  }

  for (const [sourceId, edgeList] of graph.edges) {
    const sourceNode = graph.nodes.get(sourceId);
    if (!sourceNode) continue;
    for (const edge of edgeList) {
      const targetNode = graph.nodes.get(edge.target);
      if (!targetNode) continue;
      if (sourceNode.type === 'chunk' && targetNode.type === 'chunk') continue;
      if (sourceNode.type === 'chunk') {
        const docId = findDocForChunk(sourceId);
        if (docId) addEdge(docId, edge.target, edge.type, edge.weight);
      } else if (targetNode.type === 'chunk') {
        const docId = findDocForChunk(edge.target);
        if (docId) addEdge(sourceId, docId, edge.type, edge.weight);
      } else {
        addEdge(sourceId, edge.target, edge.type, edge.weight);
      }
    }
  }

  // Filter edges: keep structural, limit entity mentions
  const structuralTypes = new Set(['belongs_to_brand', 'in_category']);
  const vizEdges = [];

  // Always keep structural edges
  for (const edge of edgeMap.values()) {
    if (structuralTypes.has(edge.type)) {
      vizEdges.push(edge);
    }
  }

  // For entity mention edges: per entity, keep only top 3 by weight
  const entityEdges = new Map(); // entityId -> [edges] sorted by weight
  for (const edge of edgeMap.values()) {
    if (structuralTypes.has(edge.type)) continue;
    const src = graph.nodes.get(edge.source) || { type: '' };
    const tgt = graph.nodes.get(edge.target) || { type: '' };
    const entityId = (src.type === 'product' || src.type === 'concept') ? edge.source :
                     (tgt.type === 'product' || tgt.type === 'concept') ? edge.target : null;
    if (entityId) {
      if (!entityEdges.has(entityId)) entityEdges.set(entityId, []);
      entityEdges.get(entityId).push(edge);
    }
  }
  for (const [, edges] of entityEdges) {
    edges.sort((a, b) => (b.weight || 1) - (a.weight || 1));
    for (const e of edges.slice(0, 3)) { // top 3 per entity
      vizEdges.push(e);
    }
  }

  for (const node of vizNodes) {
    if (node.type === 'document') {
      node.chunkCount = (graph.docChunks.get(node.label) || []).length;
    }
  }
  const entityDegree = {};
  for (const edge of vizEdges) {
    entityDegree[edge.source] = (entityDegree[edge.source] || 0) + 1;
    entityDegree[edge.target] = (entityDegree[edge.target] || 0) + 1;
  }
  for (const node of vizNodes) {
    if (node.type === 'product' || node.type === 'concept') {
      node.degree = entityDegree[node.id] || 0;
    }
  }

  console.log(`[viz] ${vizNodes.length} nodes, ${vizEdges.length} edges (from ${edgeMap.size} raw)`);

  // Remove orphan nodes (no edges after filtering) — keep only brands and documents unconditionally
  const connectedIds = new Set();
  for (const e of vizEdges) { connectedIds.add(e.source); connectedIds.add(e.target); }
  const prunedNodes = vizNodes.filter(n => {
    if (n.type === 'brand' || n.type === 'document') return true;
    return connectedIds.has(n.id);
  });
  console.log(`[viz] pruned to ${prunedNodes.length} nodes`);

  return { nodes: prunedNodes, edges: vizEdges };
}

const CHAT_PANEL_HTML = `
<style>
  .chat-panel {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 420px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    background: #F3F4F6;
    border-left: 1px solid #ddd;
  }
  .chat-header {
    padding: 14px 20px;
    border-bottom: 1px solid #ddd;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .chat-header h2 {
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 600;
    color: #333;
  }
  .chat-header button {
    background: none; border: none;
    color: #888; cursor: pointer;
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    padding: 4px 10px;
    border: 1px solid #ddd;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .chat-header button:hover { color: #333; border-color: #999; }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .chat-messages::-webkit-scrollbar { width: 4px; }
  .chat-messages::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }

  .chat-msg {
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    max-width: 95%;
    word-wrap: break-word;
  }
  .chat-msg.user {
    background: #e3ecf7;
    color: #1a3a5c;
    align-self: flex-end;
    border-bottom-right-radius: 3px;
  }
  .chat-msg.assistant {
    background: #fff;
    color: #333;
    align-self: flex-start;
    border-bottom-left-radius: 3px;
    border: 1px solid #e0e0e0;
  }
  .chat-msg.assistant .sources {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #e8e8e8;
    font-size: 10px;
    color: #888;
    font-family: 'Inter', sans-serif;
  }
  .chat-msg.assistant .sources div {
    padding: 1px 0;
    cursor: pointer;
    transition: color 0.12s;
  }
  .chat-msg.assistant .sources div:hover { color: #2a5a9a; }

  .chat-msg.system {
    background: transparent;
    color: #aaa;
    font-size: 11px;
    text-align: center;
    font-family: 'Inter', sans-serif;
    align-self: center;
    padding: 4px;
  }

  .chat-input-area {
    padding: 12px 20px 16px;
    border-top: 1px solid #ddd;
    display: flex;
    gap: 8px;
  }
  .chat-input-area input {
    flex: 1;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid #ddd;
    background: #fff;
    color: #333;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s;
  }
  .chat-input-area input:focus { border-color: #2a5a9a; }
  .chat-input-area input::placeholder { color: #bbb; }
  .chat-input-area button {
    padding: 10px 16px;
    border-radius: 8px;
    border: none;
    background: #2a5a9a;
    color: #fff;
    font-size: 13px;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    transition: background 0.15s;
  }
  .chat-input-area button:hover { background: #3a7bd5; }
  .chat-input-area button:disabled { opacity: 0.4; cursor: not-allowed; }

  .typing-indicator {
    display: none;
    align-self: flex-start;
    padding: 8px 14px;
    font-size: 12px;
    color: #999;
    font-family: 'Inter', sans-serif;
  }
  .typing-indicator.visible { display: block; }
  .typing-indicator span {
    animation: blink 1.4s infinite;
  }
  .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%,60%,100% { opacity: 0.2; } 30% { opacity: 1; } }

  /* Adjust graph area for chat panel */
  #graph-container { left: 280px; right: 420px; }
  .control-panel { z-index: 50; }
</style>

<div class="chat-panel">
  <div class="chat-header">
    <h2>Ask the knowledge base</h2>
    <button onclick="clearChat()">Clear</button>
  </div>
  <div class="chat-messages" id="chat-messages">
    <div class="chat-msg system">Ask a question about the financial documents</div>
  </div>
  <div class="typing-indicator" id="typing">
    Searching<span>.</span><span>.</span><span>.</span>
  </div>
  <div class="chat-input-area">
    <input type="text" id="chat-input" placeholder="Ask a question..." />
    <button id="chat-send" onclick="sendMessage()">Ask</button>
  </div>
</div>

<script>
// ── Chat Logic ──────────────────────────────────────────

const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const chatSend = document.getElementById('chat-send');
const typingEl = document.getElementById('typing');

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function sendMessage() {
  const query = chatInput.value.trim();
  if (!query) return;

  chatInput.value = '';
  chatSend.disabled = true;

  // Add user message
  addMessage('user', query);

  // Show typing
  typingEl.classList.add('visible');
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const data = await resp.json();

    typingEl.classList.remove('visible');

    if (data.error) {
      addMessage('system', 'Error: ' + data.error);
    } else {
      // Add answer with sources
      let sourcesHtml = '';
      if (data.sources && data.sources.length > 0) {
        sourcesHtml = '<div class="sources">' +
          data.sources.map(s => {
            const pg = s.pageStart === s.pageEnd ? 'p.' + s.pageStart : 'pp.' + s.pageStart + '-' + s.pageEnd;
            return '<div data-doc="doc:' + s.file.replace(/"/g, '&quot;') + '">[' + s.index + '] ' + s.file + ' (' + pg + ')</div>';
          }).join('') +
          '</div>';
      }
      addMessage('assistant', data.answer, sourcesHtml);

      // Highlight graph path
      if (data.path) {
        highlightPath(data.path);
      }
    }
  } catch (e) {
    typingEl.classList.remove('visible');
    addMessage('system', 'Connection error: ' + e.message);
  }

  chatSend.disabled = false;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addMessage(role, text, extraHtml = '') {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  // Simple markdown-like formatting
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>\$1</strong>')
    .replace(/\\[Source (\\d+)\\]/g, '<strong style="color:#2a5a9a">[Source \$1]</strong>')
    .replace(/\\n/g, '<br>');
  div.innerHTML = html + extraHtml;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Event delegation for source clicks
chatMessages.addEventListener('click', function(e) {
  const sourceEl = e.target.closest('[data-doc]');
  if (sourceEl) {
    focusNode(sourceEl.dataset.doc);
  }
});

function clearChat() {
  chatMessages.innerHTML = '<div class="chat-msg system">Ask a question about the financial documents</div>';
  fetch('/api/forget', { method: 'POST' });
  if (typeof clearPath === 'function') clearPath();
}

// highlightPath and focusNode are defined in graph-viz.html (vis-network)
// No need to redefine them here.
</script>
`;

// ─── CLI ─────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'ingest':
    ingest().catch(console.error);
    break;
  case 'update':
    update().catch(console.error);
    break;
  case 'search':
    search(args.join(' '), parseInt(args.find((_, i) => args[i - 1] === '--k') || '5')).catch(console.error);
    break;
  case 'ask':
    ask(args.join(' '), parseInt(args.find((_, i) => args[i - 1] === '--k') || '8')).catch(console.error);
    break;
  case 'interactive':
  case 'i':
    interactive().catch(console.error);
    break;
  case 'serve':
  case 'web':
    serve(parseInt(args[0]) || 3000).catch(console.error);
    break;
  case 'stats':
    stats();
    break;
  default:
    console.log(`
Usage: node search.js <command>

Commands:
  ingest              Scan ./docs, build vector index + knowledge graph
  update              Only process new/modified/deleted PDFs, rebuild graph
  search "query"      Retrieve matching chunks (add --k 10 for more)
  ask "question"      RAG: retrieve chunks + generate LLM answer
  interactive         Interactive mode — RAG if LLM configured (alias: i)
  serve [port]        Web UI with graph visualization + chat (alias: web)
  stats               Show index and graph statistics

Environment:
  OPENAI_API_KEY      Required for RAG (ask command and interactive mode)
  OPENAI_BASE_URL     Override API endpoint (default: https://api.openai.com/v1)
  LLM_MODEL           Override model (default: gpt-4o-mini)
`);
}
