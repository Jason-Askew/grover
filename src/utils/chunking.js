function findChunkEnd(text, start, maxChars) {
  let end = start + maxChars;
  if (end >= text.length) return text.length;

  const slice = text.slice(start, end);
  const lastPara = slice.lastIndexOf('\n\n');
  const lastNewline = slice.lastIndexOf('\n');
  const lastSentence = slice.lastIndexOf('. ');

  if (lastPara > maxChars * 0.5) return start + lastPara;
  if (lastNewline > maxChars * 0.5) return start + lastNewline;
  if (lastSentence > maxChars * 0.5) return start + lastSentence + 1;
  return end;
}

module.exports = { findChunkEnd };
