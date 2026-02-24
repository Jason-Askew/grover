const db = require('./db');

const BATCH_INSERT_SIZE = 500;

/**
 * Save index records and graph to PostgreSQL.
 * Documents + chunks are saved in a single transaction.
 * The knowledge graph is saved separately as JSONB afterwards —
 * a graph failure won't roll back the chunk data.
 */
async function saveIndex(records, dim, graph, paths = null, indexName = null) {
  const name = indexName || (paths && paths.name) || 'default';
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Delete existing data for this index (full re-ingest)
    await client.query('DELETE FROM chunks WHERE index_name = $1', [name]);
    await client.query('DELETE FROM documents WHERE index_name = $1', [name]);

    // Deduplicate documents and batch insert
    const fileMap = new Map();
    const uniqueFiles = [];
    for (const r of records) {
      if (!fileMap.has(r.file)) {
        fileMap.set(r.file, null);
        uniqueFiles.push(r);
      }
    }

    console.log(`\nSaving to PostgreSQL: ${uniqueFiles.length} documents, ${records.length} chunks...`);

    // Batch insert documents
    for (let i = 0; i < uniqueFiles.length; i += BATCH_INSERT_SIZE) {
      const batch = uniqueFiles.slice(i, i + BATCH_INSERT_SIZE);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const r of batch) {
        values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`);
        params.push(name, r.file, Math.round(r.mtime || 0), r.url || null, r.title || null, r.totalChunks || null);
        paramIdx += 6;
      }

      const result = await client.query(
        `INSERT INTO documents (index_name, file, mtime, url, title, page_count)
         VALUES ${values.join(', ')}
         RETURNING id, file`,
        params
      );

      for (const row of result.rows) {
        fileMap.set(row.file, row.id);
      }
    }

    // Batch insert chunks with embeddings
    for (let i = 0; i < records.length; i += BATCH_INSERT_SIZE) {
      const batch = records.slice(i, i + BATCH_INSERT_SIZE);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const r of batch) {
        const docId = fileMap.get(r.file);
        const vecString = r.embedding
          ? '[' + Array.from(r.embedding).join(',') + ']'
          : null;

        values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}::ruvector)`);
        params.push(
          name, docId, r.chunk, r.totalChunks,
          r.text || '', r.preview || '',
          r.pageStart != null ? Math.round(r.pageStart) : null,
          r.pageEnd != null ? Math.round(r.pageEnd) : null,
          r.pages != null ? Math.round(r.pages) : null,
          vecString
        );
        paramIdx += 10;
      }

      await client.query(
        `INSERT INTO chunks (index_name, document_id, chunk_index, total_chunks, content, preview, page_start, page_end, pages, embedding)
         VALUES ${values.join(', ')}`,
        params
      );

      if ((i + BATCH_INSERT_SIZE) % 2000 === 0 || i + BATCH_INSERT_SIZE >= records.length) {
        console.log(`  Inserted ${Math.min(i + BATCH_INSERT_SIZE, records.length)}/${records.length} chunks`);
      }
    }

    await client.query('COMMIT');

    const chunkCountRes = await client.query(
      'SELECT count(*) FROM chunks WHERE index_name = $1', [name]
    );
    const docCountRes = await client.query(
      'SELECT count(*) FROM documents WHERE index_name = $1', [name]
    );
    console.log(`\nIndex saved to PostgreSQL:`);
    console.log(`  documents: ${docCountRes.rows[0].count}`);
    console.log(`  chunks: ${chunkCountRes.rows[0].count}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Save knowledge graph separately as JSONB
  if (graph) {
    try {
      await saveGraph(graph, name);
    } catch (e) {
      console.error(`\nWarning: Graph save failed (chunks are safe): ${e.message}`);
    }
  }
}

/**
 * Save knowledge graph as serialized JSONB in the graphs table.
 * Single INSERT — far faster than individual ruvector graph function calls.
 */
async function saveGraph(graph, indexName) {
  console.log(`\n  Saving knowledge graph for "${indexName}"...`);

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

  const graphJson = JSON.stringify({ nodes, edges });

  await db.query(
    `INSERT INTO graphs (index_name, data, created_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (index_name) DO UPDATE
     SET data = $2::jsonb, created_at = NOW()`,
    [indexName, graphJson]
  );

  console.log(`  Graph saved: ${nodeCount} nodes, ${edgeCount} edges`);
}

/**
 * Load index records from PostgreSQL.
 * Returns { dim, records, graph } or null if the index doesn't exist.
 */
async function loadIndex(paths = null, indexName = null) {
  const name = indexName || (paths && paths.name) || 'default';

  const countRes = await db.query(
    'SELECT count(*) FROM chunks WHERE index_name = $1', [name]
  );
  if (parseInt(countRes.rows[0].count, 10) === 0) return null;

  const { rows } = await db.query(
    `SELECT c.id, c.chunk_index AS chunk, c.total_chunks AS "totalChunks",
            c.content AS text, c.preview, c.page_start AS "pageStart",
            c.page_end AS "pageEnd", c.pages, c.embedding,
            d.file, d.url, d.title, d.mtime
     FROM chunks c
     JOIN documents d ON c.document_id = d.id
     WHERE c.index_name = $1
     ORDER BY c.id`,
    [name]
  );

  const records = rows.map(r => ({
    id: r.file + '::chunk' + r.chunk,
    file: r.file,
    url: r.url || '',
    title: r.title || '',
    chunk: r.chunk,
    totalChunks: r.totalChunks,
    text: r.text,
    preview: r.preview,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    pages: r.pages,
    mtime: r.mtime ? Number(r.mtime) : 0,
    embedding: r.embedding ? parseRuvectorToFloat32(r.embedding) : null,
  }));

  const graph = await loadGraph(name);

  const dim = 384;
  return { dim, records, graph };
}

/**
 * Load knowledge graph from the graphs table (JSONB).
 */
async function loadGraph(indexName) {
  const { KnowledgeGraph } = require('../graph/knowledge-graph');

  try {
    const { rows } = await db.query(
      'SELECT data FROM graphs WHERE index_name = $1', [indexName]
    );
    if (rows.length === 0) return null;

    const data = rows[0].data;
    const g = new KnowledgeGraph();

    // Restore nodes
    if (data.nodes) {
      for (const [id, node] of Object.entries(data.nodes)) {
        g.addNode(id, node.type, node.label, node.meta || {});
      }
    }

    // Restore edges
    if (data.edges) {
      for (const [sourceId, edgeList] of Object.entries(data.edges)) {
        for (const edge of edgeList) {
          g.addEdge(sourceId, edge.target, edge.type, edge.weight || 1.0);
        }
      }
    }

    // Rebuild docChunks and entityIndex for viz-builder
    for (const [id, node] of g.nodes) {
      if (node.type === 'chunk' && node.meta?.file) {
        if (!g.docChunks.has(node.meta.file)) g.docChunks.set(node.meta.file, []);
        g.docChunks.get(node.meta.file).push(id);
      }
      if (node.type === 'product' || node.type === 'concept') {
        const edges = g.edges.get(id) || [];
        for (const e of edges) {
          if (e.type === 'mentions') {
            if (!g.entityIndex.has(id)) g.entityIndex.set(id, []);
            g.entityIndex.get(id).push(e.target);
          }
        }
      }
    }

    return g;
  } catch (e) {
    console.error(`[graph] Failed to load graph for "${indexName}":`, e.message);
    return null;
  }
}

/**
 * Parse ruvector column value back to Float32Array.
 */
function parseRuvectorToFloat32(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const nums = value.replace(/[\[\]]/g, '').split(',').map(Number);
    return new Float32Array(nums);
  }
  if (Array.isArray(value)) {
    return new Float32Array(value);
  }
  return null;
}

function loadIndexWithFallback(paths, indexName) {
  return loadIndex(paths, indexName);
}

module.exports = { saveIndex, loadIndex, loadIndexWithFallback };
