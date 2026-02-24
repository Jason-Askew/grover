const rv = require('ruvector');

const RVF_AVAILABLE = typeof rv.isRvfAvailable === 'function' && rv.isRvfAvailable();

const INGEST_BATCH_SIZE = 1000;

/**
 * Build an RVF (HNSW) persistent store from index records.
 * No-op when RVF native binaries are unavailable.
 */
async function buildRvfStore(rvfPath, records, dim) {
  if (!RVF_AVAILABLE) return;

  console.log(`\nBuilding RVF HNSW index (${records.length} vectors, ${dim}d)...`);
  const store = await rv.createRvfStore(rvfPath, {
    dimensions: dim,
    metric: 'cosine',
    m: 16,
    efConstruction: 200,
  });

  // RVF IDs must be string-encoded u64, so we use the array index.
  // At query time, the returned id (e.g. "42") maps to records[42].
  for (let i = 0; i < records.length; i += INGEST_BATCH_SIZE) {
    const end = Math.min(i + INGEST_BATCH_SIZE, records.length);
    const batch = [];
    for (let j = i; j < end; j++) {
      batch.push({ id: String(j), vector: Array.from(records[j].embedding) });
    }
    await rv.rvfIngest(store, batch);
  }

  await rv.rvfCompact(store);
  await rv.rvfClose(store);

  const fs = require('fs');
  if (fs.existsSync(rvfPath)) {
    const sizeMB = (fs.statSync(rvfPath).size / 1024 / 1024).toFixed(1);
    console.log(`  vectors.rvf: ${sizeMB} MB`);
  }
}

/**
 * Open an existing RVF store for querying.
 * Returns null if the file doesn't exist or RVF is unavailable.
 */
async function openRvfStoreForQuery(rvfPath) {
  if (!RVF_AVAILABLE) return null;

  const fs = require('fs');
  if (!fs.existsSync(rvfPath)) return null;

  try {
    return await rv.openRvfStore(rvfPath);
  } catch (e) {
    console.error('[rvf] Failed to open store:', e.message);
    return null;
  }
}

/**
 * HNSW k-NN search. Returns array of { id, distance }.
 */
async function queryRvfStore(store, queryVec, k, opts = {}) {
  const vector = Array.from(queryVec);
  return rv.rvfQuery(store, vector, k, { efSearch: opts.efSearch || 64 });
}

/**
 * Close an open RVF store handle.
 */
async function closeRvfStore(store) {
  if (store) await rv.rvfClose(store);
}

module.exports = { RVF_AVAILABLE, buildRvfStore, openRvfStoreForQuery, queryRvfStore, closeRvfStore };
