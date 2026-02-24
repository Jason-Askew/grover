#!/usr/bin/env node
/**
 * Save the knowledge graph for an index that already has chunks in PostgreSQL.
 * Loads records from PG, builds graph in memory, saves as JSONB.
 * Usage: node scripts/save-graph.js --index ServicesAustralia
 */
const { loadIndex } = require('../src/persistence/index-persistence');
const { KnowledgeGraph } = require('../src/graph/knowledge-graph');
const { initDb, closePool, query } = require('../src/persistence/db');

async function main() {
  const indexName = process.argv.includes('--index')
    ? process.argv[process.argv.indexOf('--index') + 1]
    : 'ServicesAustralia';

  await initDb();

  console.log(`Loading records from PostgreSQL for "${indexName}"...`);
  const index = await loadIndex(null, indexName);
  if (!index) {
    console.log('No data found for this index.');
    process.exit(1);
  }

  console.log(`  ${index.records.length} records loaded`);

  // Check how many have embeddings
  const withEmb = index.records.filter(r => r.embedding != null).length;
  console.log(`  ${withEmb} with embeddings`);

  console.log('\nBuilding knowledge graph...');
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(index.records, { domain: indexName });

  // Serialize and save
  const nodes = {};
  for (const [id, node] of graph.nodes) {
    nodes[id] = { type: node.type, label: node.label, meta: node.meta };
  }
  const edges = {};
  for (const [sourceId, edgeList] of graph.edges) {
    edges[sourceId] = edgeList.map(e => ({
      target: e.target, type: e.type, weight: e.weight,
    }));
  }
  const nodeCount = graph.nodes.size;
  const edgeCount = [...graph.edges.values()].reduce((s, e) => s + e.length, 0);

  console.log(`\nSaving graph: ${nodeCount} nodes, ${edgeCount} edges`);

  await query(
    `INSERT INTO graphs (index_name, data, node_count, edge_count)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (index_name) DO UPDATE
     SET data = $2::jsonb, node_count = $3, edge_count = $4, created_at = NOW()`,
    [indexName, JSON.stringify({ nodes, edges }), nodeCount, edgeCount]
  );

  console.log('Graph saved to PostgreSQL.');
  await closePool();
}

main().catch(e => { console.error(e); process.exit(1); });
