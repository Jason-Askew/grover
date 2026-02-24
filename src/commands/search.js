const rv = require('ruvector');
const { resolveIndex } = require('../config');
const { loadIndexWithFallback } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { formatResult } = require('../utils/formatting');
const { openRvfStoreForQuery, closeRvfStore } = require('../persistence/rvf-store');

async function search(query, k = 5, graphMode = true, indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const index = loadIndexWithFallback(paths, indexName);
  if (!index) { console.log('No index found. Run: node grover.js ingest'); return; }

  const hasGraph = !!index.graph;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);

  await rv.initOnnxEmbedder();

  // Open RVF HNSW store if available
  let rvfStore = null;
  if (paths) {
    rvfStore = await openRvfStoreForQuery(paths.rvfFile);
    if (rvfStore) console.log(`  HNSW: active`);
  }

  const { results, mode } = await retrieve(query, index, { k, graphMode, rvfStore });
  console.log(`\nResults for: "${query}" (${mode})\n`);
  results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph)));

  if (rvfStore) await closeRvfStore(rvfStore);
}

module.exports = { search };
