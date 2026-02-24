const { initDb } = require('../persistence/db');
const db = require('../persistence/db');
const { loadIndex } = require('../persistence/index-persistence');

async function stats(indexName = null) {
  await initDb();

  const name = indexName || 'default';
  const index = await loadIndex(null, name);
  if (!index) { console.log('No index found. Run: node grover.js ingest'); return; }

  const files = new Map();
  for (const r of index.records) {
    if (!files.has(r.file)) files.set(r.file, { chunks: 0, pages: r.pages });
    files.get(r.file).chunks++;
  }

  const label = indexName ? ` (${indexName})` : '';
  console.log(`\n=== Index Statistics${label} ===`);
  console.log(`Storage: PostgreSQL (ruvector HNSW)`);
  console.log(`Total files: ${files.size}`);
  console.log(`Total chunks: ${index.records.length}`);
  console.log(`Embedding dimensions: ${index.dim}`);

  // Get database size info
  const sizeRes = await db.query(
    `SELECT pg_size_pretty(pg_total_relation_size('chunks')) AS chunks_size,
            pg_size_pretty(pg_total_relation_size('documents')) AS docs_size`
  );
  if (sizeRes.rows.length > 0) {
    console.log(`Chunks table size: ${sizeRes.rows[0].chunks_size}`);
    console.log(`Documents table size: ${sizeRes.rows[0].docs_size}`);
  }

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

  // Memory stats from PostgreSQL
  const memRes = await db.query('SELECT count(*) FROM memories');
  const msgRes = await db.query('SELECT count(*) FROM chat_messages');
  const chatRes = await db.query('SELECT count(*) FROM chats');
  console.log(`\n=== Conversation Data ===`);
  console.log(`Chats: ${chatRes.rows[0].count}`);
  console.log(`Messages: ${msgRes.rows[0].count}`);
  console.log(`Memories: ${memRes.rows[0].count}`);
}

module.exports = { stats };
