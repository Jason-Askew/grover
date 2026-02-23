const { loadIndexWithFallback } = require('../src/persistence/index-persistence');
const { resolveIndex } = require('../src/config');
const { inferCategoryFromFilename } = require('../src/graph/entity-extraction');

const paths = resolveIndex('ServicesAustralia');
const index = loadIndexWithFallback(paths, 'ServicesAustralia');
const graph = index.graph;

const generalCatId = 'category:general';
let stillGeneral = 0;
let reclassified = 0;
const residuals = [];

for (const [sourceId, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId && e.type === 'in_category') {
      const node = graph.nodes.get(sourceId);
      if (!node || node.type !== 'document') continue;
      const inferred = inferCategoryFromFilename(node.label);
      if (inferred) { reclassified++; }
      else { stillGeneral++; residuals.push(node.label); }
    }
  }
}
console.log('Reclassifiable:', reclassified);
console.log('Still general:', stillGeneral);

const genEdges = graph.edges.get(generalCatId) || [];
console.log('Edges FROM general node:', genEdges.length);

let edgesToGeneral = 0;
for (const [, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId) edgesToGeneral++;
  }
}
console.log('Edges TO general node:', edgesToGeneral);
console.log('\nSample residual filenames:');
residuals.slice(0, 30).forEach(r => console.log(' ', r));
