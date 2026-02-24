const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DOCS_DIR, INDEX_DIR, resolveIndex } = require('../config');
const { findPdfs, findMarkdownFiles } = require('../utils/file-discovery');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex } = require('../persistence/index-persistence');
const { initDb } = require('../persistence/db');

const BATCH_SIZE = 500; // files per child-process batch
const BATCH_SCRIPT = path.join(__dirname, '../utils/embed-batch.js');

/**
 * Ingest files: extract text, embed with ONNX, build knowledge graph, save to PostgreSQL.
 *
 * For large markdown-only corpora (1000+ files), uses child-process batching to manage memory.
 * For smaller corpora or PDF-heavy corpora, uses in-process embedding (load ONNX once).
 */
async function ingest(indexName = null) {
  await initDb();

  const paths = indexName ? resolveIndex(indexName) : null;
  const docsDir = paths ? paths.docsDir : DOCS_DIR;
  const indexDir = paths ? paths.indexDir : INDEX_DIR;

  const pdfFiles = findPdfs(docsDir);
  const mdFiles = findMarkdownFiles(docsDir);
  const allFiles = [...pdfFiles, ...mdFiles];
  console.log(`Found ${pdfFiles.length} PDFs and ${mdFiles.length} markdown files in ${docsDir}\n`);

  if (allFiles.length === 0) { console.log('No files found.'); return; }
  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });

  let allRecords, dim;

  // Use in-process embedding for PDF-heavy or small corpora,
  // child-process batching for large markdown-only corpora
  if (pdfFiles.length > 0 || allFiles.length <= 500) {
    ({ records: allRecords, dim } = await ingestInProcess(allFiles, docsDir));
  } else {
    ({ records: allRecords, dim } = await ingestBatched(allFiles, docsDir, indexDir));
  }

  if (!dim || allRecords.length === 0) {
    console.log('No chunks produced. Check your corpus files.');
    return;
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`Total chunks: ${allRecords.length}`);

  console.log(`\n=== Building Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(allRecords, { domain: indexName || 'Westpac' });

  await saveIndex(allRecords, dim, graph, paths, indexName);
}

/**
 * In-process embedding: load ONNX once, process all files sequentially.
 * Best for PDF corpora and smaller corpora (< 500 files).
 */
async function ingestInProcess(allFiles, docsDir) {
  const rv = require('ruvector');
  const { extractPdfText, chunkPages } = require('../utils/pdf');
  const { parseMarkdown, chunkText } = require('../utils/markdown');

  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();

  const records = [];
  let errors = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    const relPath = path.relative(docsDir, filePath);
    const isMd = filePath.toLowerCase().endsWith('.md');

    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      let chunks, numPages, url = '', title = '';

      if (isMd) {
        const md = parseMarkdown(filePath);
        const allText = md.pages.map(p => p.text).join(' ').trim();
        if (allText.length < 20) { errors++; continue; }
        chunks = chunkText(allText);
        numPages = 1;
        url = md.url || '';
        title = md.title || '';
      } else {
        const pdf = extractPdfText(filePath);
        const allText = pdf.pages.map(p => p.text).join(' ').trim();
        if (allText.length < 20) { errors++; continue; }
        chunks = chunkPages(pdf.pages);
        numPages = pdf.numPages;
      }

      for (let j = 0; j < chunks.length; j++) {
        const result = await rv.embed(chunks[j].text);
        const embedding = new Float32Array(result.embedding);

        const record = {
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: numPages, pageStart: chunks[j].pageStart, pageEnd: chunks[j].pageEnd,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          mtime, embedding,
        };
        if (url) record.url = url;
        if (title) record.title = title;
        records.push(record);
      }

      if ((i + 1) % 50 === 0 || i === allFiles.length - 1) {
        console.log(`  ${i + 1}/${allFiles.length} files · ${records.length} chunks`);
      } else {
        console.error(`  OK ${relPath} — ${numPages} pages, ${chunks.length} chunks`);
      }
    } catch (e) {
      console.error(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  if (errors > 0) console.log(`  Errors: ${errors}`);
  return { records, dim };
}

/**
 * Child-process batching: spawn short-lived workers for each batch.
 * Best for large markdown-only corpora (1000+ files) where ONNX WASM
 * memory accumulation would be problematic.
 */
async function ingestBatched(allFiles, docsDir, indexDir) {
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
      '--max-old-space-size=4096',
      BATCH_SCRIPT,
      docsDir,
      prefix,
    ], {
      input: fileList,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 0,
    });

    if (result.status !== 0) {
      console.log(`\nBatch ${b + 1} failed (exit code ${result.status}${result.signal ? ', signal ' + result.signal : ''}).`);
      if (result.error) console.log(`  Error: ${result.error.message}`);
      continue;
    }

    const batchJsonFile = `${prefix}.json`;
    if (!fs.existsSync(batchJsonFile)) {
      console.log(`\nBatch ${b + 1} produced no output — skipping.`);
      continue;
    }

    const batchData = JSON.parse(fs.readFileSync(batchJsonFile, 'utf-8'));
    if (!dim && batchData.dim) dim = batchData.dim;
    allRecords.push(...batchData.records);
    totalErrors += batchData.errors;
    batchEmbFiles.push(`${prefix}.emb`);

    console.log(`  Batch ${b + 1} done: ${batchData.records.length} chunks, ${batchData.errors} errors\n`);
  }

  // Merge embeddings from batch .emb files
  if (dim && allRecords.length > 0) {
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
  }

  // Clean batch files
  cleanBatchFiles(indexDir, batches.length);

  if (totalErrors > 0) console.log(`  Total errors: ${totalErrors}`);
  return { records: allRecords, dim };
}

function cleanBatchFiles(indexDir, numBatches) {
  for (let b = 0; b < numBatches; b++) {
    const prefix = path.join(indexDir, `batch_${b}`);
    try { fs.unlinkSync(`${prefix}.emb`); } catch (_) {}
    try { fs.unlinkSync(`${prefix}.json`); } catch (_) {}
  }
}

module.exports = { ingest };
