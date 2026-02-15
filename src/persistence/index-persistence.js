const fs = require('fs');
const { INDEX_DIR, META_FILE, EMBEDDINGS_FILE, GRAPH_FILE } = require('../config');
const { KnowledgeGraph } = require('../graph/knowledge-graph');

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

module.exports = { saveIndex, loadIndex };
