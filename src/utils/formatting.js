function formatResult(r, i, showGraph = false) {
  const meta = r.file ? r : JSON.parse(r.metadata || '{}');
  const score = (r.combinedScore ?? r.score ?? r.vectorScore ?? 0).toFixed(4);
  const pageLabel = meta.pageStart === meta.pageEnd
    ? `p.${meta.pageStart}` : `pp.${meta.pageStart}-${meta.pageEnd}`;

  let header = `  ${i + 1}. [${score}] ${meta.file} (${pageLabel})`;

  if (showGraph && r.sources) {
    const tags = r.sources.filter(s => s !== 'vector');
    if (tags.length > 0) {
      header += `  <- graph: ${tags.join(', ')}`;
    }
    if (r.graphScore > 0) {
      header += ` [+${r.graphScore.toFixed(2)} boost]`;
    }
  }

  const text = meta.text || meta.preview || '';
  return `${header}\n     ${text}\n`;
}

function formatContext(results) {
  return results.map((r, i) => {
    const meta = r.file ? r : {};
    const pageLabel = meta.pageStart === meta.pageEnd
      ? `page ${meta.pageStart}` : `pages ${meta.pageStart}-${meta.pageEnd}`;
    const source = `[Source ${i + 1}: ${meta.file || 'unknown'}, ${pageLabel}]`;
    const text = meta.text || meta.preview || '';
    return `${source}\n${text}`;
  }).join('\n\n---\n\n');
}

module.exports = { formatResult, formatContext };
