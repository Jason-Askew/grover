const fs = require('fs');
const { EMBEDDINGS_FILE, GRAPH_FILE, MEMORY_FILE } = require('../config');
const { loadIndex } = require('../persistence/index-persistence');

function stats() {
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

module.exports = { stats };
