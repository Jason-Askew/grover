const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DOCS_DIR, INDEX_DIR, resolveIndex } = require('../config');
const { findPdfs, findMarkdownFiles } = require('../utils/file-discovery');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex } = require('../persistence/index-persistence');
const { initDb } = require('../persistence/db');
const db = require('../persistence/db');
const { ingest } = require('./ingest');

const BATCH_SIZE = 500;
const BATCH_SCRIPT = path.join(__dirname, '../utils/embed-batch.js');

async function update(indexName = null) {
  // Verify PostgreSQL connection
  await initDb();

  const paths = indexName ? resolveIndex(indexName) : null;
  const docsDir = paths ? paths.docsDir : DOCS_DIR;
  const indexDir = paths ? paths.indexDir : INDEX_DIR;
  const name = indexName || 'default';

  // Check if index exists in PostgreSQL
  const countRes = await db.query(
    'SELECT count(*) FROM documents WHERE index_name = $1', [name]
  );
  if (parseInt(countRes.rows[0].count, 10) === 0) {
    console.log('No existing index found. Running full ingest instead.\n');
    return ingest(indexName);
  }

  // Get dimension from existing chunks
  const dimRes = await db.query(
    `SELECT ruvector_dims(embedding) AS dim FROM chunks
     WHERE index_name = $1 AND embedding IS NOT NULL LIMIT 1`,
    [name]
  );
  const dim = dimRes.rows.length > 0 ? dimRes.rows[0].dim : 384;

  const pdfFiles = findPdfs(docsDir);
  const mdFiles = findMarkdownFiles(docsDir);
  const currentFiles = [...pdfFiles, ...mdFiles];
  const currentRelPaths = new Set(currentFiles.map(f => path.relative(docsDir, f)));

  // Get indexed files from PostgreSQL
  const { rows: indexedRows } = await db.query(
    'SELECT file, mtime FROM documents WHERE index_name = $1', [name]
  );
  const indexedFiles = new Map();
  for (const r of indexedRows) {
    indexedFiles.set(r.file, Number(r.mtime) || 0);
  }

  const toAdd = [];
  const toUpdate = [];
  const toRemove = new Set();

  for (const filePath of currentFiles) {
    const relPath = path.relative(docsDir, filePath);
    const currentMtime = fs.statSync(filePath).mtimeMs;
    if (!indexedFiles.has(relPath)) toAdd.push(filePath);
    else if (currentMtime > indexedFiles.get(relPath)) toUpdate.push(filePath);
  }

  for (const indexedFile of indexedFiles.keys()) {
    if (!currentRelPaths.has(indexedFile)) toRemove.add(indexedFile);
  }

  // Get current chunk count
  const chunkCountRes = await db.query(
    'SELECT count(*) FROM chunks WHERE index_name = $1', [name]
  );

  console.log(`Index: ${indexedFiles.size} files, ${chunkCountRes.rows[0].count} chunks (${dim}d)`);
  console.log(`New: ${toAdd.length} · Modified: ${toUpdate.length} · Deleted: ${toRemove.size}`);

  if (toAdd.length === 0 && toUpdate.length === 0 && toRemove.size === 0) {
    console.log('\nIndex is up to date.');
    return;
  }

  // Remove deleted/modified files from PostgreSQL
  const removeFiles = new Set([...toRemove, ...toUpdate.map(f => path.relative(docsDir, f))]);
  if (removeFiles.size > 0) {
    const fileList = [...removeFiles];
    // Delete chunks (cascade from documents)
    await db.query(
      `DELETE FROM documents WHERE index_name = $1 AND file = ANY($2)`,
      [name, fileList]
    );
    console.log(`  Removed ${fileList.length} files from index`);
  }

  // Load remaining records from PostgreSQL (for graph rebuild)
  const { rows: existingRows } = await db.query(
    `SELECT c.chunk_index AS chunk, c.total_chunks AS "totalChunks",
            c.content AS text, c.preview, c.page_start AS "pageStart",
            c.page_end AS "pageEnd", c.pages, c.embedding,
            d.file, d.url, d.title, d.mtime
     FROM chunks c
     JOIN documents d ON c.document_id = d.id
     WHERE c.index_name = $1
     ORDER BY c.id`,
    [name]
  );

  const records = existingRows.map(r => ({
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

  const existingCount = records.length;

  // Process new/modified files via batch child processes
  const filesToProcess = [...toAdd, ...toUpdate];
  let totalErrors = 0;
  const batchEmbFiles = [];

  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });

  if (filesToProcess.length > 0) {
    const batches = [];
    for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
      batches.push(filesToProcess.slice(i, i + BATCH_SIZE));
    }

    console.log(`\nProcessing ${filesToProcess.length} new/modified files in ${batches.length} batch(es)...\n`);

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const prefix = path.join(indexDir, `batch_${b}`);
      const fileList = batch.join('\n');

      console.log(`=== Batch ${b + 1}/${batches.length} (${batch.length} files) ===`);

      const result = spawnSync('node', [
        '--max-old-space-size=6144',
        BATCH_SCRIPT,
        docsDir,
        prefix,
      ], {
        input: fileList,
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: 0, // no timeout — batches can take 30+ min for large corpora
      });

      if (result.status !== 0) {
        console.log(`\nBatch ${b + 1} failed (exit code ${result.status}).`);
        if (result.error) console.log(`  Error: ${result.error.message}`);
        cleanTempFiles(indexDir, b);
        return;
      }

      const batchJsonFile = `${prefix}.json`;
      if (!fs.existsSync(batchJsonFile)) {
        console.log(`\nBatch ${b + 1} produced no output. Aborting.`);
        cleanTempFiles(indexDir, b);
        return;
      }

      const batchData = JSON.parse(fs.readFileSync(batchJsonFile, 'utf-8'));
      records.push(...batchData.records);
      totalErrors += batchData.errors;
      batchEmbFiles.push(`${prefix}.emb`);

      console.log(`  Batch ${b + 1} done: ${batchData.records.length} chunks, ${batchData.errors} errors\n`);
    }
  }

  const newChunks = records.length - existingCount;
  console.log(`\n=== Update Complete ===`);
  console.log(`Removed: ${removeFiles.size} files · Added: ${newChunks} chunks · Total: ${records.length}`);

  // Load batch embeddings
  if (batchEmbFiles.length > 0) {
    console.log(`\nLoading embeddings for new chunks...`);
    let embOffset = existingCount;
    for (const embFile of batchEmbFiles) {
      const embBuffer = fs.readFileSync(embFile);
      const numVectors = embBuffer.length / (dim * 4);
      for (let i = 0; i < numVectors; i++) {
        const embedding = new Float32Array(dim);
        for (let j = 0; j < dim; j++) {
          embedding[j] = embBuffer.readFloatLE((i * dim + j) * 4);
        }
        records[embOffset + i].embedding = embedding;
      }
      embOffset += numVectors;
    }
  }

  console.log(`\n=== Rebuilding Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records, { domain: indexName || 'Westpac' });

  await saveIndex(records, dim, graph, paths, indexName);

  // Clean up temp files
  cleanTempFiles(indexDir, batchEmbFiles.length);
}

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

function cleanTempFiles(indexDir, numBatches) {
  for (let b = 0; b < numBatches; b++) {
    const prefix = path.join(indexDir, `batch_${b}`);
    try { fs.unlinkSync(`${prefix}.emb`); } catch (_) {}
    try { fs.unlinkSync(`${prefix}.json`); } catch (_) {}
  }
}

module.exports = { update };
