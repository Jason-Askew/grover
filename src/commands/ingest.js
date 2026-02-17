const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const { DOCS_DIR, resolveIndex } = require('../config');
const { findPdfs, findMarkdownFiles } = require('../utils/file-discovery');
const { extractPdfText, chunkPages } = require('../utils/pdf');
const { parseMarkdown, chunkText } = require('../utils/markdown');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex } = require('../persistence/index-persistence');

async function ingest(indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  const docsDir = paths ? paths.docsDir : DOCS_DIR;

  console.log('Initializing ONNX embedder...');
  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();
  console.log(`ONNX ready: ${dim}d\n`);

  const pdfFiles = findPdfs(docsDir);
  const mdFiles = findMarkdownFiles(docsDir);
  const totalFiles = pdfFiles.length + mdFiles.length;
  console.log(`Found ${pdfFiles.length} PDFs and ${mdFiles.length} markdown files in ${docsDir}\n`);

  if (totalFiles === 0) { console.log('No files found.'); return; }

  const records = [];
  let errors = 0;
  let processed = 0;

  // Process PDFs
  for (let i = 0; i < pdfFiles.length; i++) {
    const filePath = pdfFiles[i];
    const relPath = path.relative(docsDir, filePath);

    try {
      const pdf = extractPdfText(filePath);
      const mtime = fs.statSync(filePath).mtimeMs;
      const allText = pdf.pages.map(p => p.text).join(' ').trim();
      if (allText.length < 20) {
        console.log(`  SKIP ${relPath}: no extractable text`);
        errors++;
        continue;
      }

      const chunks = chunkPages(pdf.pages);

      for (let j = 0; j < chunks.length; j++) {
        const result = await rv.embed(chunks[j].text);
        records.push({
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: pdf.numPages, pageStart: chunks[j].pageStart, pageEnd: chunks[j].pageEnd,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          mtime, embedding: new Float32Array(result.embedding),
        });
      }

      processed++;
      const pct = ((processed + errors) / totalFiles * 100).toFixed(0);
      console.log(`  [${pct}%] ${relPath} — ${pdf.numPages} pages, ${chunks.length} chunks`);

    } catch (e) {
      console.log(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  // Process markdown files
  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i];
    const relPath = path.relative(docsDir, filePath);

    try {
      const md = parseMarkdown(filePath);
      const mtime = fs.statSync(filePath).mtimeMs;
      const allText = md.pages.map(p => p.text).join(' ').trim();
      if (allText.length < 20) {
        console.log(`  SKIP ${relPath}: no extractable text`);
        errors++;
        continue;
      }

      const chunks = chunkText(allText);

      for (let j = 0; j < chunks.length; j++) {
        const result = await rv.embed(chunks[j].text);
        records.push({
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: 1, pageStart: 1, pageEnd: 1,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          url: md.url || '', title: md.title || '',
          mtime, embedding: new Float32Array(result.embedding),
        });
      }

      processed++;
      const pct = ((processed + errors) / totalFiles * 100).toFixed(0);
      const label = md.title || relPath;
      console.log(`  [${pct}%] ${relPath} — ${label}, ${chunks.length} chunks`);

    } catch (e) {
      console.log(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`Files processed: ${processed}/${totalFiles} (${pdfFiles.length} PDFs, ${mdFiles.length} markdown)`);
  console.log(`Total chunks: ${records.length}`);

  console.log(`\n=== Building Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records, { domain: indexName || 'Westpac' });

  saveIndex(records, dim, graph, paths);
}

module.exports = { ingest };
