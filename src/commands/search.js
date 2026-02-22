const rv = require('ruvector');
const { resolveIndex } = require('../config');
const { loadIndexWithFallback } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { formatResult } = require('../utils/formatting');

async function search(query, k = 5, graphMode = true, indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const index = loadIndexWithFallback(paths, indexName);
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const hasGraph = !!index.graph;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);

  await rv.initOnnxEmbedder();

  const { results, mode } = await retrieve(query, index, { k, graphMode });
  console.log(`\nResults for: "${query}" (${mode})\n`);
  results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph)));
}

module.exports = { search };
