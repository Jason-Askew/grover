const rv = require('ruvector');
const path = require('path');
const { DOCS_DIR } = require('../config');
const { findPdfs } = require('../utils/file-discovery');
const { extractPdfText, chunkPages } = require('../utils/pdf');
const { KnowledgeGraph } = require('../graph/knowledge-graph');
const { saveIndex } = require('../persistence/index-persistence');

async function ingest() {
  console.log('Initializing ONNX embedder...');
  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();
  console.log(`ONNX ready: ${dim}d\n`);

  const files = findPdfs(DOCS_DIR);
  console.log(`Found ${files.length} PDFs in ${DOCS_DIR}\n`);

  if (files.length === 0) { console.log('No PDFs found.'); return; }

  const records = [];
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relPath = path.relative(DOCS_DIR, filePath);

    try {
      const pdf = extractPdfText(filePath);
      const fs = require('fs');
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

      const pct = ((i + 1) / files.length * 100).toFixed(0);
      console.log(`  [${pct}%] ${relPath} — ${pdf.numPages} pages, ${chunks.length} chunks`);

    } catch (e) {
      console.log(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`PDFs processed: ${files.length - errors}/${files.length}`);
  console.log(`Total chunks: ${records.length}`);

  console.log(`\n=== Building Knowledge Graph ===`);
  const graph = new KnowledgeGraph();
  graph.buildFromRecords(records);

  saveIndex(records, dim, graph);
}

module.exports = { ingest };
