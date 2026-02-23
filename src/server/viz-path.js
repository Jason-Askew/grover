/**
 * Build a subgraph of nodes/edges cited by search results,
 * for highlighting in the vis-network visualization.
 */
function buildCitedVizPath(graph, sources, vizData) {
  if (!graph) return null;
  const citedFiles = new Set(sources.map(s => s.file));
  const citedDocIds = new Set([...citedFiles].map(f => `doc:${f}`));
  if (citedDocIds.size === 0) return null;

  const pathNodes = new Set();
  const pathEdges = [];

  // 1. From the raw graph: find brand, category, product, concept connections
  for (const docId of citedDocIds) {
    if (!graph.nodes.has(docId)) continue;
    pathNodes.add(docId);
    const edges = graph.edges.get(docId) || [];
    for (const edge of edges) {
      const targetNode = graph.nodes.get(edge.target);
      if (!targetNode) continue;
      if (['brand', 'category', 'product', 'concept'].includes(targetNode.type)) {
        pathNodes.add(edge.target);
        pathEdges.push({ source: docId, target: edge.target, type: edge.type });
      }
    }
  }

  // 2. From the viz data: find doc-to-doc relationships (semantically_similar,
  //    shared_concept) which are collapsed from chunk-level edges by viz-builder
  if (vizData && vizData.edges) {
    for (const edge of vizData.edges) {
      if (citedDocIds.has(edge.source) && citedDocIds.has(edge.target)) {
        pathNodes.add(edge.source);
        pathNodes.add(edge.target);
        pathEdges.push({ source: edge.source, target: edge.target, type: edge.type });
      }
    }
  }

  // 3. Find shared entities between cited documents (entities connected to 2+ cited docs)
  const entityToDocs = new Map();
  for (const e of pathEdges) {
    if (e.type === 'mentions') {
      if (!entityToDocs.has(e.target)) entityToDocs.set(e.target, new Set());
      entityToDocs.get(e.target).add(e.source);
    }
  }
  for (const [entityId, docSet] of entityToDocs) {
    if (docSet.size >= 2) {
      pathNodes.add(entityId);
    }
  }

  const edgeSet = new Set();
  const uniqueEdges = pathEdges.filter(e => {
    const k = `${e.source}|${e.target}|${e.type}`;
    if (edgeSet.has(k)) return false;
    edgeSet.add(k);
    return true;
  });

  return { nodes: [...pathNodes], edges: uniqueEdges };
}

module.exports = { buildCitedVizPath };
