function buildVizData(graph) {
  if (!graph) return { nodes: [], edges: [] };

  const vizNodes = [];
  const vizNodeIds = new Set();

  for (const [id, node] of graph.nodes) {
    if (node.type === 'chunk') continue;
    vizNodes.push({ id, type: node.type, label: node.label, meta: node.meta || {} });
    vizNodeIds.add(id);
  }

  const edgeMap = new Map();

  function addEdge(source, target, type, weight) {
    if (!vizNodeIds.has(source) || !vizNodeIds.has(target)) return;
    if (source === target) return;
    const key = `${source}|${target}|${type}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight = (existing.weight || 1) + (weight || 1);
    } else {
      edgeMap.set(key, { source, target, type, weight: weight || 1 });
    }
  }

  function findDocForChunk(chunkId) {
    for (const [file, chunks] of graph.docChunks) {
      if (chunks.includes(chunkId)) return `doc:${file}`;
    }
    return null;
  }

  for (const [sourceId, edgeList] of graph.edges) {
    const sourceNode = graph.nodes.get(sourceId);
    if (!sourceNode) continue;
    for (const edge of edgeList) {
      const targetNode = graph.nodes.get(edge.target);
      if (!targetNode) continue;
      if (sourceNode.type === 'chunk' && targetNode.type === 'chunk') {
        // Collapse chunk-to-chunk similarity edges to doc-to-doc
        const srcDoc = findDocForChunk(sourceId);
        const tgtDoc = findDocForChunk(edge.target);
        if (srcDoc && tgtDoc && srcDoc !== tgtDoc) {
          addEdge(srcDoc, tgtDoc, edge.type, edge.weight);
        }
        continue;
      }
      if (sourceNode.type === 'chunk') {
        const docId = findDocForChunk(sourceId);
        if (docId) addEdge(docId, edge.target, edge.type, edge.weight);
      } else if (targetNode.type === 'chunk') {
        const docId = findDocForChunk(edge.target);
        if (docId) addEdge(sourceId, docId, edge.type, edge.weight);
      } else {
        addEdge(sourceId, edge.target, edge.type, edge.weight);
      }
    }
  }

  // Filter edges — keep structural, similarity, and entity edges
  const alwaysKeepTypes = new Set(['belongs_to_brand', 'in_category', 'semantically_similar', 'shared_concept']);
  const vizEdges = [];

  // Keep similarity edges — per doc, top N by weight to avoid clutter
  const simByDoc = new Map();
  for (const edge of edgeMap.values()) {
    if (edge.type === 'semantically_similar' || edge.type === 'shared_concept') {
      for (const docId of [edge.source, edge.target]) {
        if (!simByDoc.has(docId)) simByDoc.set(docId, []);
        simByDoc.get(docId).push(edge);
      }
    } else if (edge.type === 'belongs_to_brand' || edge.type === 'in_category') {
      vizEdges.push(edge);
    }
  }
  const addedSimEdges = new Set();
  for (const [, edges] of simByDoc) {
    edges.sort((a, b) => (b.weight || 1) - (a.weight || 1));
    for (const e of edges.slice(0, 3)) {
      const key = `${e.source}|${e.target}|${e.type}`;
      if (!addedSimEdges.has(key)) {
        addedSimEdges.add(key);
        vizEdges.push(e);
      }
    }
  }

  // Per entity, keep only top 3 by weight
  const entityEdges = new Map();
  for (const edge of edgeMap.values()) {
    if (alwaysKeepTypes.has(edge.type)) continue;
    const src = graph.nodes.get(edge.source) || { type: '' };
    const tgt = graph.nodes.get(edge.target) || { type: '' };
    const entityId = (src.type === 'product' || src.type === 'concept') ? edge.source :
                     (tgt.type === 'product' || tgt.type === 'concept') ? edge.target : null;
    if (entityId) {
      if (!entityEdges.has(entityId)) entityEdges.set(entityId, []);
      entityEdges.get(entityId).push(edge);
    }
  }
  for (const [, edges] of entityEdges) {
    edges.sort((a, b) => (b.weight || 1) - (a.weight || 1));
    for (const e of edges.slice(0, 3)) {
      vizEdges.push(e);
    }
  }

  for (const node of vizNodes) {
    if (node.type === 'document') {
      node.chunkCount = (graph.docChunks.get(node.label) || []).length;
    }
  }
  const entityDegree = {};
  for (const edge of vizEdges) {
    entityDegree[edge.source] = (entityDegree[edge.source] || 0) + 1;
    entityDegree[edge.target] = (entityDegree[edge.target] || 0) + 1;
  }
  for (const node of vizNodes) {
    if (node.type === 'product' || node.type === 'concept') {
      node.degree = entityDegree[node.id] || 0;
    }
  }

  console.log(`[viz] ${vizNodes.length} nodes, ${vizEdges.length} edges (from ${edgeMap.size} raw)`);

  // Remove orphan nodes
  const connectedIds = new Set();
  for (const e of vizEdges) { connectedIds.add(e.source); connectedIds.add(e.target); }
  const prunedNodes = vizNodes.filter(n => {
    if (n.type === 'brand' || n.type === 'document') return true;
    return connectedIds.has(n.id);
  });
  console.log(`[viz] pruned to ${prunedNodes.length} nodes`);

  return { nodes: prunedNodes, edges: vizEdges };
}

module.exports = { buildVizData };
