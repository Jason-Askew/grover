const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DOCS_DIR, INDEX_DIR, resolveIndex } = require('../config');
const { findPdfs, findMarkdownFiles } = require('../utils/file-discovery');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex } = require('../persistence/index-persistence');

const BATCH_SIZE = 500;
const BATCH_SCRIPT = path.join(__dirname, '../utils/embed-batch.js');

/**
 * Ingest files using batch child processes.
 * Each batch spawns a short-lived child that loads ONNX, embeds its files,
 * writes results to disk, then exits — freeing the ~4GB WASM allocation.
 */
async function ingest(indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const docsDir = paths ? paths.docsDir : DOCS_DIR;
  const indexDir = paths ? paths.indexDir : INDEX_DIR;

  const pdfFiles = findPdfs(docsDir);
  const mdFiles = findMarkdownFiles(docsDir);
  const allFiles = [...pdfFiles, ...mdFiles];
  console.log(`Found ${pdfFiles.length} PDFs and ${mdFiles.length} markdown files in ${docsDir}\n`);

  if (allFiles.length === 0) { console.log('No files found.'); return; }

  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });

  // Split files into batches
  const batches = [];
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    batches.push(allFiles.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${allFiles.length} files in ${batches.length} batch(es) of up to ${BATCH_SIZE}...\n`);

  let dim = null;
  const allRecords = [];
  let totalErrors = 0;
  const batchEmbFiles = [];

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
      cleanBatchFiles(indexDir, b);
      return;
    }

    // Read batch results
    const batchJsonFile = `${prefix}.json`;
    if (!fs.existsSync(batchJsonFile)) {
      console.log(`\nBatch ${b + 1} produced no output. Aborting.`);
      cleanBatchFiles(indexDir, b);
      return;
    }

    const batchData = JSON.parse(fs.readFileSync(batchJsonFile, 'utf-8'));
    if (!dim && batchData.dim) dim = batchData.dim;
    allRecords.push(...batchData.records);
    totalErrors += batchData.errors;
    batchEmbFiles.push(`${prefix}.emb`);

    console.log(`  Batch ${b + 1} done: ${batchData.records.length} chunks, ${batchData.errors} errors\n`);
  }

  if (!dim || allRecords.length === 0) {
    console.log('No chunks produced. Check your corpus files.');
    cleanBatchFiles(indexDir, batches.length);
    return;
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`Total chunks: ${allRecords.length} · Errors: ${totalErrors}`);

  // Merge embeddings from all batch .emb files and attach to records
  console.log(`\nLoading embeddings for graph build...`);
  let embOffset = 0;
  for (const embFile of batchEmbFiles) {
    const embBuffer = fs.readFileSync(embFile);
    const numVectors = embBuffer.length / (dim * 4);
    for (let i = 0; i < numVectors; i++) {
      const embedding = new Float32Array(dim);
      for (let j = 0; j < dim; j++) {
        embedding[j] = embBuffer.readFloatLE((i * dim + j) * 4);
      }
      allRecords[embOffset + i].embedding = embedding;
    }
    embOffset += numVectors;
  }

  console.log(`\n=== Building Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(allRecords, { domain: indexName || 'Westpac' });

  saveIndex(allRecords, dim, graph, paths);

  // Clean up batch files
  cleanBatchFiles(indexDir, batches.length);
}

function cleanBatchFiles(indexDir, numBatches) {
  for (let b = 0; b < numBatches; b++) {
    const prefix = path.join(indexDir, `batch_${b}`);
    try { fs.unlinkSync(`${prefix}.emb`); } catch (_) {}
    try { fs.unlinkSync(`${prefix}.json`); } catch (_) {}
  }
}

module.exports = { ingest };
