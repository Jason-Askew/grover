const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DOCS_DIR, INDEX_DIR, resolveIndex } = require('../config');
const { findPdfs, findMarkdownFiles } = require('../utils/file-discovery');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex, loadIndexWithFallback } = require('../persistence/index-persistence');
const { ingest } = require('./ingest');

const BATCH_SIZE = 500;
const BATCH_SCRIPT = path.join(__dirname, '../utils/embed-batch.js');

async function update(indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const docsDir = paths ? paths.docsDir : DOCS_DIR;
  const indexDir = paths ? paths.indexDir : INDEX_DIR;

  let index = loadIndexWithFallback(paths, indexName);
  if (!index) {
    console.log('No existing index found. Running full ingest instead.\n');
    return ingest(indexName);
  }

  const dim = index.dim;

  const pdfFiles = findPdfs(docsDir);
  const mdFiles = findMarkdownFiles(docsDir);
  const currentFiles = [...pdfFiles, ...mdFiles];
  const currentRelPaths = new Set(currentFiles.map(f => path.relative(docsDir, f)));

  const indexedFiles = new Map();
  for (const r of index.records) {
    if (!indexedFiles.has(r.file)) indexedFiles.set(r.file, r.mtime || 0);
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

  console.log(`Index: ${indexedFiles.size} files, ${index.records.length} chunks (${dim}d)`);
  console.log(`New: ${toAdd.length} · Modified: ${toUpdate.length} · Deleted: ${toRemove.size}`);

  if (toAdd.length === 0 && toUpdate.length === 0 && toRemove.size === 0) {
    console.log('\nIndex is up to date.');
    return;
  }

  // Filter out records for removed/modified files, keep their embeddings for disk streaming
  const removeFiles = new Set([...toRemove, ...toUpdate.map(f => path.relative(docsDir, f))]);
  let records = index.records.filter(r => !removeFiles.has(r.file));
  const removedChunks = index.records.length - records.length;

  // Stream existing record embeddings to temp file, then free them from memory
  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });
  const existingEmbFile = path.join(indexDir, 'existing_emb.tmp');
  const embFd = fs.openSync(existingEmbFile, 'w');
  const embWriteBuf = Buffer.alloc(dim * 4);
  const existingCount = records.length;

  for (const r of records) {
    if (r.embedding) {
      for (let k = 0; k < dim; k++) embWriteBuf.writeFloatLE(r.embedding[k], k * 4);
      fs.writeSync(embFd, embWriteBuf);
      delete r.embedding;
    }
  }
  fs.closeSync(embFd);

  // Free the loaded index to reclaim memory
  index = null;
  console.log(`  Streamed ${existingCount} existing embeddings to disk`);

  // Process new/modified files via batch child processes
  const filesToProcess = [...toAdd, ...toUpdate];
  let totalErrors = 0;
  const batchEmbFiles = [];

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
        cleanTempFiles(indexDir, b, existingEmbFile);
        return;
      }

      const batchJsonFile = `${prefix}.json`;
      if (!fs.existsSync(batchJsonFile)) {
        console.log(`\nBatch ${b + 1} produced no output. Aborting.`);
        cleanTempFiles(indexDir, b, existingEmbFile);
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
  console.log(`Removed: ${removedChunks} chunks · Added: ${newChunks} chunks · Total: ${records.length}`);

  // Load all embeddings back: existing + batch results
  console.log(`\nLoading embeddings for graph build...`);

  // Existing embeddings
  const existingBuffer = fs.readFileSync(existingEmbFile);
  for (let i = 0; i < existingCount; i++) {
    const embedding = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      embedding[j] = existingBuffer.readFloatLE((i * dim + j) * 4);
    }
    records[i].embedding = embedding;
  }

  // Batch embeddings
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

  console.log(`\n=== Rebuilding Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records, { domain: indexName || 'Westpac' });

  saveIndex(records, dim, graph, paths);

  // Clean up temp files
  cleanTempFiles(indexDir, batchEmbFiles.length, existingEmbFile);
}

function cleanTempFiles(indexDir, numBatches, existingEmbFile) {
  for (let b = 0; b < numBatches; b++) {
    const prefix = path.join(indexDir, `batch_${b}`);
    try { fs.unlinkSync(`${prefix}.emb`); } catch (_) {}
    try { fs.unlinkSync(`${prefix}.json`); } catch (_) {}
  }
  try { fs.unlinkSync(existingEmbFile); } catch (_) {}
}

module.exports = { update };
