const rv = require('ruvector');
const { vectorSearch } = require('./vector-search');
const { rewriteQuery } = require('../llm/query-rewrite');
const { queryRvfStore } = require('../persistence/rvf-store');

async function retrieve(query, index, { k = 5, graphMode = true, memory = null, rvfStore = null } = {}) {
  const searchQuery = await rewriteQuery(query, memory);

  const hasGraph = !!index.graph;
  const result = await rv.embed(searchQuery);
  const queryVec = new Float32Array(result.embedding);
  const vectorK = hasGraph && graphMode ? Math.max(k, 10) : k;

  let parsed;
  let useHnsw = false;

  if (rvfStore && index.records) {
    // HNSW search via RVF — IDs are string-encoded array indices
    try {
      const rvfResults = await queryRvfStore(rvfStore, queryVec, vectorK);
      parsed = rvfResults
        .map(r => {
          const idx = parseInt(r.id, 10);
          const record = index.records[idx];
          if (!record) return null;
          return { ...record, id: record.id, score: r.distance, vectorScore: r.distance };
        })
        .filter(Boolean);
      useHnsw = true;
    } catch (e) {
      console.error('[retrieve] HNSW search failed, falling back to brute-force:', e.message);
    }
  }

  if (!parsed) {
    // Brute-force fallback
    const vectorResults = vectorSearch(queryVec, index.records, vectorK);
    parsed = vectorResults.map(r => ({
      ...r.record, id: r.id, score: r.score, vectorScore: r.score,
    }));
  }

  const modePrefix = useHnsw ? 'hnsw' : 'vector';

  if (hasGraph && graphMode) {
    const { results, path } = index.graph.expandResults(parsed, index.records, k);
    return { results, path, mode: `${modePrefix}+graph`, queryVec };
  }
  return { results: parsed.slice(0, k), path: null, mode: modePrefix, queryVec };
}

module.exports = { retrieve };
