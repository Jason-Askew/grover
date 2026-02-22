const fs = require('fs');
const { INDEX_DIR, META_FILE, EMBEDDINGS_FILE, GRAPH_FILE } = require('../config');
const { KnowledgeGraph } = require('../graph/knowledge-graph');

function saveIndex(records, dim, graph, paths = null) {
  const indexDir = paths ? paths.indexDir : INDEX_DIR;
  const metaFile = paths ? paths.metaFile : META_FILE;
  const embeddingsFile = paths ? paths.embeddingsFile : EMBEDDINGS_FILE;
  const graphFile = paths ? paths.graphFile : GRAPH_FILE;

  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });

  const meta = records.map(r => ({
    id: r.id, file: r.file, chunk: r.chunk, totalChunks: r.totalChunks,
    pages: r.pages, preview: r.preview, text: r.text,
    pageStart: r.pageStart, pageEnd: r.pageEnd, mtime: r.mtime || 0,
    ...(r.url ? { url: r.url } : {}),
    ...(r.title ? { title: r.title } : {}),
  }));
  fs.writeFileSync(metaFile, JSON.stringify({ dim, count: records.length, records: meta }, null, 2));

  const buffer = Buffer.alloc(records.length * dim * 4);
  for (let i = 0; i < records.length; i++) {
    for (let j = 0; j < dim; j++) {
      buffer.writeFloatLE(records[i].embedding[j], (i * dim + j) * 4);
    }
  }
  fs.writeFileSync(embeddingsFile, buffer);

  if (graph) {
    fs.writeFileSync(graphFile, JSON.stringify(graph.toJSON()));
  }

  console.log(`\nIndex saved to ${indexDir}/`);
  console.log(`  metadata.json: ${(fs.statSync(metaFile).size / 1024).toFixed(0)} KB`);
  console.log(`  embeddings.bin: ${(fs.statSync(embeddingsFile).size / 1024 / 1024).toFixed(1)} MB`);
  if (graph && fs.existsSync(graphFile)) {
    console.log(`  graph.json: ${(fs.statSync(graphFile).size / 1024).toFixed(0)} KB`);
  }
}

function loadIndex(paths = null) {
  const metaFile = paths ? paths.metaFile : META_FILE;
  const embeddingsFile = paths ? paths.embeddingsFile : EMBEDDINGS_FILE;
  const graphFile = paths ? paths.graphFile : GRAPH_FILE;

  if (!fs.existsSync(metaFile) || !fs.existsSync(embeddingsFile)) return null;

  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  const buffer = fs.readFileSync(embeddingsFile);
  const dim = meta.dim;

  const records = meta.records.map((r, i) => {
    const embedding = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      embedding[j] = buffer.readFloatLE((i * dim + j) * 4);
    }
    return { ...r, embedding };
  });

  let graph = null;
  if (fs.existsSync(graphFile)) {
    graph = KnowledgeGraph.fromJSON(JSON.parse(fs.readFileSync(graphFile, 'utf-8')));
  }

  return { dim, records, graph };
}

function loadIndexWithFallback(paths, indexName) {
  let index = loadIndex(paths);
  if (!index && indexName === 'Westpac') index = loadIndex();
  return index;
}

module.exports = { saveIndex, loadIndex, loadIndexWithFallback };
