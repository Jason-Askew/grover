const { cosineSim } = require('../utils/math');
const { extractEntities, extractDocMeta, DOMAINS } = require('./entity-extraction');

class KnowledgeGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.entityIndex = new Map();
    this.docChunks = new Map();
  }

  addNode(id, type, label, meta = {}) {
    this.nodes.set(id, { type, label, meta });
    if (!this.edges.has(id)) this.edges.set(id, []);
  }

  addEdge(source, target, type, weight = 1.0) {
    if (!this.edges.has(source)) this.edges.set(source, []);
    const existing = this.edges.get(source);
    if (!existing.find(e => e.target === target && e.type === type)) {
      existing.push({ target, type, weight });
    }
  }

  addBidirectional(a, b, type, weight = 1.0) {
    this.addEdge(a, b, type, weight);
    this.addEdge(b, a, type, weight);
  }

  getNeighbors(id, edgeType = null, maxDepth = 1) {
    const visited = new Set();
    const results = [];

    const traverse = (nodeId, depth) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);

      const edges = this.edges.get(nodeId) || [];
      for (const edge of edges) {
        if (edgeType && edge.type !== edgeType) continue;
        if (visited.has(edge.target)) continue;
        results.push({ id: edge.target, type: edge.type, weight: edge.weight, depth });
        traverse(edge.target, depth + 1);
      }
    };

    traverse(id, 0);
    return results;
  }

  buildFromRecords(records, opts = {}) {
    console.log('  Building knowledge graph...');
    const domain = opts.domain || 'Westpac';
    const d = DOMAINS[domain] || DOMAINS.Westpac;

    const filesSeen = new Set();
    for (const r of records) {
      this.addNode(r.id, 'chunk', r.preview?.slice(0, 80), {
        file: r.file, chunk: r.chunk, pageStart: r.pageStart, pageEnd: r.pageEnd,
      });

      const docId = `doc:${r.file}`;
      if (!filesSeen.has(r.file)) {
        filesSeen.add(r.file);
        const docMeta = extractDocMeta(r.file, domain);
        if (r.url) docMeta.url = r.url;
        if (r.title) docMeta.title = r.title;
        this.addNode(docId, 'document', r.file, docMeta);
        this.docChunks.set(r.file, []);

        if (docMeta.brand) {
          const brandId = `brand:${docMeta.brand}`;
          if (!this.nodes.has(brandId)) {
            this.addNode(brandId, 'brand', d.brands[docMeta.brand]);
          }
          this.addBidirectional(docId, brandId, 'belongs_to_brand');
        }
        if (docMeta.category) {
          const catId = `category:${docMeta.category}`;
          if (!this.nodes.has(catId)) {
            this.addNode(catId, 'category', d.categories[docMeta.category]);
          }
          this.addBidirectional(docId, catId, 'in_category');
        }
      }

      this.addEdge(r.id, docId, 'part_of', 1.0);
      this.addEdge(docId, r.id, 'contains', 1.0);
      this.docChunks.get(r.file).push(r.id);

      const entities = extractEntities(r.text || r.preview || '', domain);
      for (const entity of entities) {
        if (!this.nodes.has(entity)) {
          const [type, name] = entity.split(':');
          this.addNode(entity, type, name);
        }
        this.addBidirectional(r.id, entity, 'mentions', 0.8);

        if (!this.entityIndex.has(entity)) this.entityIndex.set(entity, []);
        this.entityIndex.get(entity).push(r.id);
      }
    }

    // Build co-occurrence edges
    for (const [entity, chunkIds] of this.entityIndex) {
      if (chunkIds.length > 1 && chunkIds.length < 50) {
        for (let i = 0; i < chunkIds.length; i++) {
          for (let j = i + 1; j < chunkIds.length; j++) {
            const fileA = this.nodes.get(chunkIds[i])?.meta?.file;
            const fileB = this.nodes.get(chunkIds[j])?.meta?.file;
            if (fileA !== fileB) {
              this.addBidirectional(chunkIds[i], chunkIds[j], 'shared_concept', 0.5);
            }
          }
        }
      }
    }

    // Build semantic similarity edges
    console.log('  Computing cross-document similarities...');
    const SIM_THRESHOLD = 0.85;
    let simEdges = 0;

    const byFile = new Map();
    for (const r of records) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    const fileList = [...byFile.keys()];

    for (let i = 0; i < fileList.length; i++) {
      const chunksA = byFile.get(fileList[i]);
      const repsA = [
        chunksA[0],
        chunksA[Math.floor(chunksA.length / 2)],
        chunksA[chunksA.length - 1],
      ].filter(Boolean);

      for (let j = i + 1; j < fileList.length; j++) {
        const chunksB = byFile.get(fileList[j]);
        const repsB = [
          chunksB[0],
          chunksB[Math.floor(chunksB.length / 2)],
          chunksB[chunksB.length - 1],
        ].filter(Boolean);

        for (const a of repsA) {
          for (const b of repsB) {
            const sim = cosineSim(a.embedding, b.embedding);
            if (sim > SIM_THRESHOLD) {
              this.addBidirectional(a.id, b.id, 'semantically_similar', sim);
              simEdges++;
            }
          }
        }
      }
    }

    let totalEdges = 0;
    for (const edges of this.edges.values()) totalEdges += edges.length;
    const entityCount = [...this.nodes.values()].filter(n => n.type === 'product' || n.type === 'concept').length;

    console.log(`  Graph built:`);
    console.log(`    ${this.nodes.size} nodes (${filesSeen.size} docs, ${records.length} chunks, ${entityCount} entities)`);
    console.log(`    ${totalEdges} edges (${simEdges} similarity links)`);
  }

  expandResults(vectorResults, allRecords, k = 10) {
    const resultIds = new Set(vectorResults.map(r => r.id));
    const scored = new Map();

    const pathNodes = new Set();
    const pathEdges = [];

    for (const r of vectorResults) {
      scored.set(r.id, {
        vectorScore: r.score,
        graphScore: 0,
        sources: ['vector'],
        ...r,
      });
      pathNodes.add(r.id);
      if (r.file) {
        const docId = `doc:${r.file}`;
        pathNodes.add(docId);
        pathEdges.push({ source: r.id, target: docId, type: 'part_of' });

        const docNode = this.nodes.get(docId);
        const meta = docNode?.meta || {};
        if (meta.brand) {
          const brandId = `brand:${meta.brand}`;
          if (this.nodes.has(brandId)) {
            pathNodes.add(brandId);
            pathEdges.push({ source: docId, target: brandId, type: 'belongs_to_brand' });
          }
        }
        if (meta.category) {
          const catId = `category:${meta.category}`;
          if (this.nodes.has(catId)) {
            pathNodes.add(catId);
            pathEdges.push({ source: docId, target: catId, type: 'in_category' });
          }
        }
      }
    }

    for (const r of vectorResults) {
      const neighbors = this.getNeighbors(r.id, null, 2);

      for (const neighbor of neighbors) {
        if (neighbor.id.startsWith('brand:') || neighbor.id.startsWith('category:')) continue;
        if (neighbor.id.startsWith('doc:')) continue;

        const node = this.nodes.get(neighbor.id);
        if (!node || node.type !== 'chunk') continue;

        const weight = neighbor.weight * (neighbor.depth === 0 ? 1.0 : 0.5);

        pathNodes.add(neighbor.id);
        pathEdges.push({ source: r.id, target: neighbor.id, type: neighbor.type });

        if (neighbor.depth > 0) {
          const sourceEdges = this.edges.get(r.id) || [];
          for (const e of sourceEdges) {
            const eNode = this.nodes.get(e.target);
            if (eNode && (eNode.type === 'product' || eNode.type === 'concept')) {
              const entityEdges = this.edges.get(e.target) || [];
              if (entityEdges.some(ee => ee.target === neighbor.id)) {
                pathNodes.add(e.target);
                pathEdges.push({ source: r.id, target: e.target, type: 'mentions' });
                pathEdges.push({ source: e.target, target: neighbor.id, type: 'mentions' });
              }
            }
          }
        }

        if (scored.has(neighbor.id)) {
          const existing = scored.get(neighbor.id);
          existing.graphScore += weight;
          if (!existing.sources.includes(neighbor.type)) {
            existing.sources.push(neighbor.type);
          }
        } else {
          const record = allRecords.find(rec => rec.id === neighbor.id);
          if (record) {
            scored.set(neighbor.id, {
              id: neighbor.id,
              vectorScore: 2.0,
              graphScore: weight,
              sources: [neighbor.type],
              file: record.file,
              url: record.url || '',
              chunk: record.chunk,
              totalChunks: record.totalChunks,
              pages: record.pages,
              pageStart: record.pageStart,
              pageEnd: record.pageEnd,
              preview: record.preview,
              text: record.text,
            });

            if (record.file) {
              const docId = `doc:${record.file}`;
              pathNodes.add(docId);
              pathEdges.push({ source: neighbor.id, target: docId, type: 'part_of' });
            }
          }
        }
      }
    }

    // Normalise graph boost: cap at 30% of the vector score range
    // so graph expansion improves ranking but can't overpower vector relevance
    const allScored = [...scored.values()];
    const maxGraphScore = Math.max(...allScored.map(r => r.graphScore), 1);
    const vectorScores = allScored.filter(r => r.vectorScore < 2.0).map(r => r.vectorScore);
    const vectorRange = vectorScores.length > 1
      ? Math.max(vectorScores[vectorScores.length - 1] - vectorScores[0], 0.01)
      : 0.1;
    const boostScale = (vectorRange * 0.3) / maxGraphScore;

    const combined = allScored
      .map(r => ({
        ...r,
        combinedScore: r.vectorScore - (r.graphScore * boostScale),
      }))
      .sort((a, b) => a.combinedScore - b.combinedScore)
      .slice(0, k);

    const edgeSet = new Set();
    const uniquePathEdges = pathEdges.filter(e => {
      const key = `${e.source}|${e.target}|${e.type}`;
      if (edgeSet.has(key)) return false;
      edgeSet.add(key);
      return true;
    });

    return {
      results: combined,
      path: { nodes: [...pathNodes], edges: uniquePathEdges },
    };
  }

  toJSON() {
    return {
      nodes: [...this.nodes.entries()],
      edges: [...this.edges.entries()],
      entityIndex: [...this.entityIndex.entries()],
      docChunks: [...this.docChunks.entries()],
    };
  }

  static fromJSON(data) {
    const g = new KnowledgeGraph();
    g.nodes = new Map(data.nodes);
    g.edges = new Map(data.edges);
    g.entityIndex = new Map(data.entityIndex);
    g.docChunks = new Map(data.docChunks);
    return g;
  }
}

module.exports = { KnowledgeGraph };
