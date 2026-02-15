const rv = require('ruvector');
const { vectorSearch } = require('./vector-search');
const { rewriteQuery } = require('../llm/query-rewrite');

async function retrieve(query, index, { k = 5, graphMode = true, memory = null } = {}) {
  const searchQuery = await rewriteQuery(query, memory);

  const hasGraph = !!index.graph;
  const result = await rv.embed(searchQuery);
  const queryVec = new Float32Array(result.embedding);
  const vectorK = hasGraph && graphMode ? Math.max(k, 10) : k;
  const vectorResults = vectorSearch(queryVec, index.records, vectorK);

  const parsed = vectorResults.map(r => ({
    ...r.record, id: r.id, score: r.score, vectorScore: r.score,
  }));

  if (hasGraph && graphMode) {
    const { results, path } = index.graph.expandResults(parsed, index.records, k);
    return { results, path, mode: 'vector+graph' };
  }
  return { results: parsed.slice(0, k), path: null, mode: 'vector' };
}

module.exports = { retrieve };
