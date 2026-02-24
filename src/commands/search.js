const rv = require('ruvector');
const { initDb } = require('../persistence/db');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { formatResult } = require('../utils/formatting');

async function search(query, k = 5, graphMode = true, indexName = null) {
  await initDb();

  const index = await loadIndex(null, indexName);
  if (!index) { console.log('No index found. Run: node grover.js ingest'); return; }

  const hasGraph = !!index.graph;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  console.log(`  HNSW: active (PostgreSQL ruvector)`);

  await rv.initOnnxEmbedder();

  const { results, mode } = await retrieve(query, index, { k, graphMode, indexName });
  console.log(`\nResults for: "${query}" (${mode})\n`);
  results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph)));
}

module.exports = { search };
