const fs = require('fs');
const { EMBEDDINGS_FILE, GRAPH_FILE, MEMORY_FILE, resolveIndex } = require('../config');
const { loadIndexWithFallback } = require('../persistence/index-persistence');

function stats(indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const index = loadIndexWithFallback(paths, indexName);
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const embeddingsFile = paths ? paths.embeddingsFile : EMBEDDINGS_FILE;
  const graphFile = paths ? paths.graphFile : GRAPH_FILE;
  const memoryFile = paths ? paths.memoryFile : MEMORY_FILE;

  const files = new Map();
  for (const r of index.records) {
    if (!files.has(r.file)) files.set(r.file, { chunks: 0, pages: r.pages });
    files.get(r.file).chunks++;
  }

  const label = indexName ? ` (${indexName})` : '';
  console.log(`\n=== Index Statistics${label} ===`);
  console.log(`Total files: ${files.size}`);
  console.log(`Total chunks: ${index.records.length}`);
  console.log(`Embedding dimensions: ${index.dim}`);
  console.log(`Index size: ${(fs.statSync(embeddingsFile).size / 1024 / 1024).toFixed(1)} MB`);

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
    console.log(`Graph file: ${(fs.statSync(graphFile).size / 1024).toFixed(0)} KB`);
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

  if (fs.existsSync(memoryFile)) {
    try {
      const memData = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      console.log(`\n=== Conversation Memory ===`);
      console.log(`Past interactions: ${(memData.memories || []).length}`);
      console.log(`History messages: ${(memData.history || []).length}`);
      console.log(`Memory file: ${(fs.statSync(memoryFile).size / 1024).toFixed(0)} KB`);
    } catch (e) {
      if (process.env.GROVER_DEBUG === '1') console.error('[debug] Memory parse error:', e.message);
    }
  }
}

module.exports = { stats };
