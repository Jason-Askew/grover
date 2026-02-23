const { inferCategoryFromFilename } = require('../graph/entity-extraction');

function buildVizData(graph) {
  if (!graph) return { nodes: [], edges: [] };

  // Build reverse lookup: chunkId -> "doc:<file>" (O(1) per lookup)
  const chunkToDoc = new Map();
  for (const [file, chunks] of graph.docChunks) {
    const docId = `doc:${file}`;
    for (const cId of chunks) chunkToDoc.set(cId, docId);
  }

  // --- Retroactive category inference for existing graph data ---
  // Reassign docs whose only category is 'general' to an inferred category
  const generalCatId = 'category:general';
  const edgeList = graph.edges.get(generalCatId) || [];
  const incomingToGeneral = new Set();

  // Collect all edges that point TO category:general
  for (const [sourceId, edges] of graph.edges) {
    for (const e of edges) {
      if (e.target === generalCatId && e.type === 'in_category') {
        incomingToGeneral.add(sourceId);
      }
    }
  }
  // Also check edges FROM category:general
  for (const e of edgeList) {
    if (e.type === 'in_category') incomingToGeneral.add(e.target);
  }

  let reclassified = 0;
  for (const docId of incomingToGeneral) {
    const node = graph.nodes.get(docId);
    if (!node || node.type !== 'document') continue;
    const basename = node.label.split('/').pop();
    const inferred = inferCategoryFromFilename(basename);
    if (!inferred) continue;

    const newCatId = `category:${inferred}`;
    // Ensure category node exists
    if (!graph.nodes.has(newCatId)) {
      const { SA_CATEGORIES } = require('../domain-constants-sa');
      graph.nodes.set(newCatId, {
        type: 'category',
        label: SA_CATEGORIES[inferred] || inferred,
        meta: {},
      });
    }

    // Rewrite edges: remove in_category to general, add to new category
    const docEdges = graph.edges.get(docId);
    if (docEdges) {
      for (let i = docEdges.length - 1; i >= 0; i--) {
        if (docEdges[i].target === generalCatId && docEdges[i].type === 'in_category') {
          docEdges[i].target = newCatId;
          reclassified++;
        }
      }
    }
    // Also rewrite reverse edges from general -> doc
    for (let i = edgeList.length - 1; i >= 0; i--) {
      if (edgeList[i].target === docId && edgeList[i].type === 'in_category') {
        edgeList[i].target = docId; // keep target
        // Move this edge to the new category's edge list
        if (!graph.edges.has(newCatId)) graph.edges.set(newCatId, []);
        graph.edges.get(newCatId).push(edgeList[i]);
        edgeList.splice(i, 1);
      }
    }
  }
  if (reclassified > 0) {
    console.log(`[viz] reclassified ${reclassified} docs from general to inferred categories`);
  }

  const vizNodes = [];
  const vizNodeIds = new Set();

  // Count remaining edges to general — skip if still too large (>50 docs)
  let generalRemaining = 0;
  for (const [, edges] of graph.edges) {
    for (const e of edges) {
      if (e.target === generalCatId && e.type === 'in_category') generalRemaining++;
    }
  }
  const skipGeneral = generalRemaining > 50;
  if (skipGeneral) {
    console.log(`[viz] category:general still has ${generalRemaining} docs — skipping hub node`);
  }

  // Merge legacy brand nodes into matching category nodes (SA_BRANDS was emptied;
  // existing graph data may still contain brand:X that duplicates category:X)
  const mergedBrands = new Set();
  for (const [id, node] of graph.nodes) {
    if (node.type !== 'brand') continue;
    const key = id.replace('brand:', '');
    const catId = `category:${key}`;
    if (!graph.nodes.has(catId)) continue;
    mergedBrands.add(id);
    // Redirect all edges from/to this brand node to the category node
    for (const [, srcEdges] of graph.edges) {
      for (const e of srcEdges) {
        if (e.target === id) e.target = catId;
      }
    }
    const brandEdges = graph.edges.get(id) || [];
    for (const e of brandEdges) {
      if (!graph.edges.has(catId)) graph.edges.set(catId, []);
      graph.edges.get(catId).push({ target: e.target, type: e.type, weight: e.weight });
    }
  }
  if (mergedBrands.size > 0) {
    console.log(`[viz] merged ${mergedBrands.size} legacy brand nodes into categories`);
  }

  for (const [id, node] of graph.nodes) {
    if (node.type === 'chunk') continue;
    if (skipGeneral && id === generalCatId) continue;
    if (mergedBrands.has(id)) continue;
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

  for (const [sourceId, srcEdges] of graph.edges) {
    const sourceNode = graph.nodes.get(sourceId);
    if (!sourceNode) continue;
    for (const edge of srcEdges) {
      const targetNode = graph.nodes.get(edge.target);
      if (!targetNode) continue;
      if (sourceNode.type === 'chunk' && targetNode.type === 'chunk') {
        // Collapse chunk-to-chunk similarity edges to doc-to-doc
        const srcDoc = chunkToDoc.get(sourceId);
        const tgtDoc = chunkToDoc.get(edge.target);
        if (srcDoc && tgtDoc && srcDoc !== tgtDoc) {
          addEdge(srcDoc, tgtDoc, edge.type, edge.weight);
        }
        continue;
      }
      if (sourceNode.type === 'chunk') {
        const docId = chunkToDoc.get(sourceId);
        if (docId) addEdge(docId, edge.target, edge.type, edge.weight);
      } else if (targetNode.type === 'chunk') {
        const docId = chunkToDoc.get(edge.target);
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
    if (n.type === 'brand') return true;
    return connectedIds.has(n.id);
  });
  console.log(`[viz] pruned to ${prunedNodes.length} nodes`);

  return { nodes: prunedNodes, edges: vizEdges };
}

module.exports = { buildVizData };
