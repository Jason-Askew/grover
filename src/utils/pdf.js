const { execFileSync } = require('child_process');
const { findChunkEnd } = require('./chunking');

function extractPdfText(filePath) {
  const script = `
import pymupdf, json, sys
doc = pymupdf.open(sys.argv[1])
pages = []
for i, page in enumerate(doc):
    pages.append({"page": i + 1, "text": page.get_text()})
print(json.dumps({"numPages": len(pages), "pages": pages}))
`;
  const result = execFileSync('python3', ['-c', script, filePath], {
    maxBuffer: 50 * 1024 * 1024,
    encoding: 'utf-8',
    timeout: 30000,
  });
  return JSON.parse(result);
}

function chunkPages(pages, maxChars = 1000, overlap = 200) {
  const segments = [];
  let fullText = '';
  for (const p of pages) {
    const cleaned = p.text.replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned.length === 0) continue;
    const start = fullText.length;
    fullText += (fullText.length > 0 ? '\n\n' : '') + cleaned;
    segments.push({ page: p.page, start, end: fullText.length });
  }

  if (fullText.length < 20) return [];

  const rawChunks = [];
  if (fullText.length <= maxChars) {
    rawChunks.push({ start: 0, end: fullText.length });
  } else {
    let start = 0;
    while (start < fullText.length) {
      const end = findChunkEnd(fullText, start, maxChars);
      rawChunks.push({ start, end });
      start = end - overlap;
    }
  }

  return rawChunks
    .map(c => {
      const text = fullText.slice(c.start, c.end).trim();
      if (text.length < 20) return null;
      const chunkPages = segments
        .filter(s => s.start < c.end && s.end > c.start)
        .map(s => s.page);
      return {
        text,
        pageStart: Math.min(...chunkPages),
        pageEnd: Math.max(...chunkPages),
      };
    })
    .filter(Boolean);
}

module.exports = { extractPdfText, chunkPages };
