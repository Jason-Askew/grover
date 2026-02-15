const rv = require('ruvector');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { formatResult } = require('../utils/formatting');

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

module.exports = { search };
