const fs = require('fs');
const { findChunkEnd } = require('./chunking');

function parseMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');

  let meta = {};
  let body = raw;

  // Extract YAML front-matter
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) {
      const frontMatter = raw.slice(3, endIdx).trim();
      body = raw.slice(endIdx + 3).trim();
      for (const line of frontMatter.split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim();
          const val = line.slice(colon + 1).trim();
          meta[key] = val;
        }
      }
    }
  }

  return {
    title: meta.title || '',
    url: meta.url || '',
    source: meta.source || '',
    numPages: 1,
    pages: [{ page: 1, text: body }],
  };
}

function chunkText(text, maxChars = 1000, overlap = 200) {
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length < 20) return [];

  if (cleaned.length <= maxChars) {
    return [{ text: cleaned, pageStart: 1, pageEnd: 1 }];
  }

  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = findChunkEnd(cleaned, start, maxChars);
    const slice = cleaned.slice(start, end).trim();
    if (slice.length >= 20) {
      chunks.push({ text: slice, pageStart: 1, pageEnd: 1 });
    }
    if (end >= cleaned.length) break;
    const newStart = end - overlap;
    if (newStart <= start) break;
    start = newStart;
  }
  return chunks;
}

module.exports = { parseMarkdown, chunkText };
