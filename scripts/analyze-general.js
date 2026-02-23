const { loadIndexWithFallback } = require('../src/persistence/index-persistence');
const { resolveIndex } = require('../src/config');
const { inferCategoryFromFilename } = require('../src/graph/entity-extraction');

const paths = resolveIndex('ServicesAustralia');
const index = loadIndexWithFallback(paths, 'ServicesAustralia');
const graph = index.graph;

const generalCatId = 'category:general';
const residuals = [];

for (const [sourceId, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId && e.type === 'in_category') {
      const node = graph.nodes.get(sourceId);
      if (!node || node.type !== 'document') continue;
      const basename = node.label.split('/').pop();
      const inferred = inferCategoryFromFilename(basename);
      if (!inferred) residuals.push(basename);
    }
  }
}

residuals.sort();
console.log('Total uncategorized:', residuals.length);
console.log('\n--- ALL FILENAMES ---');
residuals.forEach(r => console.log(r));
