const rv = require('ruvector');
const db = require('../persistence/db');
const { rewriteQuery } = require('../llm/query-rewrite');

/**
 * Retrieve relevant chunks using PostgreSQL HNSW + BM25 hybrid search.
 * Replaces the old file-based HNSW/brute-force + in-memory graph expansion.
 */
async function retrieve(query, index, { k = 5, graphMode = true, memory = null, indexName = null } = {}) {
  const searchQuery = await rewriteQuery(query, memory);

  const result = await rv.embed(searchQuery);
  const queryVec = new Float32Array(result.embedding);
  const vecString = '[' + Array.from(queryVec).join(',') + ']';
  const vectorK = graphMode ? Math.max(k, 10) : k;

  // Hybrid search: HNSW vector + BM25 text, fused via Reciprocal Rank Fusion
  const { rows } = await db.query(`
    WITH vector_results AS (
      SELECT c.id, c.chunk_index, c.content, c.preview,
             c.page_start, c.page_end, c.pages,
             c.embedding <=> $1::ruvector AS distance,
             d.file, d.url, d.title, d.mtime
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.index_name = $2
      ORDER BY c.embedding <=> $1::ruvector
      LIMIT $3
    ),
    text_results AS (
      SELECT c.id, c.chunk_index, c.content, c.preview,
             c.page_start, c.page_end, c.pages,
             ts_rank(c.tsv, plainto_tsquery('english', $4)) AS text_rank,
             d.file, d.url, d.title, d.mtime
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.index_name = $2 AND c.tsv @@ plainto_tsquery('english', $4)
      ORDER BY text_rank DESC
      LIMIT $3
    ),
    ranked AS (
      SELECT *, 1.0 / (60 + ROW_NUMBER() OVER (ORDER BY distance)) AS rrf_score,
             'vector' AS source
      FROM vector_results
      UNION ALL
      SELECT id, chunk_index, content, preview,
             page_start, page_end, pages,
             1.0 - text_rank AS distance,
             file, url, title, mtime,
             1.0 / (60 + ROW_NUMBER() OVER (ORDER BY text_rank DESC)) AS rrf_score,
             'text' AS source
      FROM text_results
    ),
    fused AS (
      SELECT id, chunk_index, content, preview,
             page_start, page_end, pages,
             MIN(distance) AS distance,
             file, url, title, mtime,
             SUM(rrf_score) AS combined_rrf
      FROM ranked
      GROUP BY id, chunk_index, content, preview, page_start, page_end, pages, file, url, title, mtime
    )
    SELECT * FROM fused
    ORDER BY combined_rrf DESC
    LIMIT $3
  `, [vecString, indexName, vectorK, searchQuery]);

  let parsed = rows.map(r => ({
    id: r.file + '::chunk' + r.chunk_index,
    file: r.file,
    url: r.url || '',
    title: r.title || '',
    text: r.content,
    preview: r.preview,
    pageStart: r.page_start,
    pageEnd: r.page_end,
    pages: r.pages,
    chunk: r.chunk_index,
    score: r.distance,
    vectorScore: r.distance,
  }));

  const mode = 'hybrid+graph';

  if (graphMode && index && index.graph) {
    const { results, path } = index.graph.expandResults(parsed, index.records, k);
    return { results, path, mode, queryVec };
  }

  return { results: parsed.slice(0, k), path: null, mode: 'hybrid', queryVec };
}

module.exports = { retrieve };
