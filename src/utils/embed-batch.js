#!/usr/bin/env node
/**
 * Child process worker for batch embedding.
 * Loads ONNX, embeds all chunks from a batch of files, writes results to disk, then exits.
 * This isolates the ~4GB WASM memory allocation to a short-lived process.
 *
 * Usage: node embed-batch.js <docsDir> <outputPrefix>
 * Reads newline-delimited file paths from stdin.
 * Outputs: <outputPrefix>.emb (binary embeddings) and <outputPrefix>.json (metadata + dim).
 */

const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const { extractPdfText, chunkPages } = require('./pdf');
const { parseMarkdown, chunkText } = require('./markdown');

async function main() {
  const [docsDir, outputPrefix] = process.argv.slice(2);

  // Read file list from stdin
  const input = fs.readFileSync(0, 'utf-8').trim();
  if (!input) {
    fs.writeFileSync(`${outputPrefix}.json`, JSON.stringify({ dim: 0, records: [], errors: 0 }));
    process.exit(0);
  }
  const filePaths = input.split('\n');

  await rv.initOnnxEmbedder();
  const dim = await rv.getDimension();

  const embFd = fs.openSync(`${outputPrefix}.emb`, 'w');
  const embBuf = Buffer.alloc(dim * 4);
  const records = [];
  let errors = 0;

  for (const filePath of filePaths) {
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
        for (let k = 0; k < dim; k++) embBuf.writeFloatLE(result.embedding[k], k * 4);
        fs.writeSync(embFd, embBuf);

        const record = {
          id: `${relPath}::chunk${j}`,
          file: relPath, chunk: j, totalChunks: chunks.length,
          pages: numPages, pageStart: chunks[j].pageStart, pageEnd: chunks[j].pageEnd,
          preview: chunks[j].text.slice(0, 200), text: chunks[j].text,
          mtime,
        };
        if (url) record.url = url;
        if (title) record.title = title;
        records.push(record);
      }

      console.error(`  OK ${relPath} — ${numPages} pages, ${chunks.length} chunks`);

    } catch (e) {
      console.error(`  ERROR ${relPath}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }

  fs.closeSync(embFd);
  fs.writeFileSync(`${outputPrefix}.json`, JSON.stringify({ dim, records, errors }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
