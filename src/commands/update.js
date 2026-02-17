const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const { DOCS_DIR, resolveIndex } = require('../config');
const { findPdfs, findMarkdownFiles } = require('../utils/file-discovery');
const { extractPdfText, chunkPages } = require('../utils/pdf');
const { parseMarkdown, chunkText } = require('../utils/markdown');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex, loadIndex } = require('../persistence/index-persistence');
const { ingest } = require('./ingest');

async function update(indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const docsDir = paths ? paths.docsDir : DOCS_DIR;

  let index = loadIndex(paths);
  if (!index && indexName === 'Westpac') index = loadIndex();
  if (!index) {
    console.log('No existing index found. Running full ingest instead.\n');
    return ingest(indexName);
  }

  console.log('Initializing ONNX embedder...');
  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();
  console.log(`ONNX ready: ${dim}d\n`);

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

  console.log(`Index: ${indexedFiles.size} files, ${index.records.length} chunks`);
  console.log(`New: ${toAdd.length} · Modified: ${toUpdate.length} · Deleted: ${toRemove.size}`);

  if (toAdd.length === 0 && toUpdate.length === 0 && toRemove.size === 0) {
    console.log('\nIndex is up to date.');
    return;
  }

  const removeFiles = new Set([...toRemove, ...toUpdate.map(f => path.relative(docsDir, f))]);
  let records = index.records.filter(r => !removeFiles.has(r.file));
  const removedChunks = index.records.length - records.length;

  const filesToProcess = [...toAdd, ...toUpdate];
  let newChunks = 0;
  let errors = 0;

  for (let i = 0; i < filesToProcess.length; i++) {
    const filePath = filesToProcess[i];
    const relPath = path.relative(docsDir, filePath);
    const isMd = filePath.toLowerCase().endsWith('.md');

    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      let chunks;
      let numPages;

      if (isMd) {
        const md = parseMarkdown(filePath);
        const allText = md.pages.map(p => p.text).join(' ').trim();
        if (allText.length < 20) { errors++; continue; }
        chunks = chunkText(allText);
        numPages = 1;
      } else {
        const pdf = extractPdfText(filePath);
        const allText = pdf.pages.map(p => p.text).join(' ').trim();
        if (allText.length < 20) { errors++; continue; }
        chunks = chunkPages(pdf.pages);
        numPages = pdf.numPages;
      }

      for (let j = 0; j < chunks.length; j++) {
        const result = await rv.embed(chunks[j].text);
        records.push({
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: numPages, pageStart: chunks[j].pageStart, pageEnd: chunks[j].pageEnd,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          mtime, embedding: new Float32Array(result.embedding),
        });
        newChunks++;
      }

      const label = toAdd.includes(filePath) ? 'NEW' : 'UPDATED';
      const pct = ((i + 1) / filesToProcess.length * 100).toFixed(0);
      console.log(`  [${pct}%] [${label}] ${relPath} — ${numPages} pages, ${chunks.length} chunks`);

    } catch (e) {
      console.log(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  console.log(`\n=== Update Complete ===`);
  console.log(`Removed: ${removedChunks} chunks · Added: ${newChunks} chunks · Total: ${records.length}`);

  console.log(`\n=== Rebuilding Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records, { domain: indexName || 'Westpac' });

  saveIndex(records, dim, graph, paths);
}

module.exports = { update };
