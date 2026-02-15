function vectorSearch(queryVec, records, k) {
  const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));

  const scored = new Float64Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const emb = records[i].embedding;
    let dot = 0, norm = 0;
    for (let j = 0; j < queryVec.length; j++) {
      dot += queryVec[j] * emb[j];
      norm += emb[j] * emb[j];
    }
    scored[i] = 1 - (dot / (queryNorm * Math.sqrt(norm) + 1e-8));
  }

  const indices = Array.from({ length: records.length }, (_, i) => i);
  indices.sort((a, b) => scored[a] - scored[b]);

  return indices.slice(0, k).map(i => ({
    id: records[i].id,
    score: scored[i],
    record: records[i],
  }));
}

module.exports = { vectorSearch };
