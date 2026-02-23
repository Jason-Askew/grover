const { loadIndexWithFallback } = require('../src/persistence/index-persistence');
const { resolveIndex } = require('../src/config');
const { inferCategoryFromFilename } = require('../src/graph/entity-extraction');

const paths = resolveIndex('ServicesAustralia');
const index = loadIndexWithFallback(paths, 'ServicesAustralia');
const graph = index.graph;

const generalCatId = 'category:general';
const cats = {};
const unmatched = [];

for (const [sourceId, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId && e.type === 'in_category') {
      const node = graph.nodes.get(sourceId);
      if (!node || node.type !== 'document') continue;
      const basename = node.label.split('/').pop();
      const inferred = inferCategoryFromFilename(basename);
      if (inferred) {
        cats[inferred] = (cats[inferred] || 0) + 1;
      } else {
        unmatched.push(basename);
      }
    }
  }
}

const total = Object.values(cats).reduce((a, b) => a + b, 0) + unmatched.length;
console.log('=== CATEGORY DISTRIBUTION ===');
Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k}: ${v}`);
});
console.log(`\nCategorized: ${total - unmatched.length} / ${total} (${((total - unmatched.length) / total * 100).toFixed(1)}%)`);
console.log(`Unmatched: ${unmatched.length}`);

if (unmatched.length > 0) {
  console.log('\n=== UNMATCHED ===');
  unmatched.sort().forEach(f => console.log('  ' + f));
}
