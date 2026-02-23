const { loadIndexWithFallback } = require('../src/persistence/index-persistence');
const { resolveIndex } = require('../src/config');
const { inferCategoryFromFilename } = require('../src/graph/entity-extraction');

const paths = resolveIndex('ServicesAustralia');
const index = loadIndexWithFallback(paths, 'ServicesAustralia');
const graph = index.graph;

// Check what node.label looks like for doc nodes in general
const generalCatId = 'category:general';
let checked = 0;
for (const [sourceId, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId && e.type === 'in_category') {
      const node = graph.nodes.get(sourceId);
      if (!node || node.type !== 'document') continue;
      if (checked < 5) {
        console.log('node.id:', sourceId);
        console.log('node.label:', node.label);
        console.log('inferred:', inferCategoryFromFilename(node.label));
        console.log('---');
      }
      checked++;
    }
  }
}

// Test inference on just the basename
console.log('\nTest basename extraction:');
const tests = ['general/ac001.md', 'general/about-mygov.md', 'general/medicare-card-for-newborns.md'];
for (const t of tests) {
  const basename = t.split('/').pop();
  console.log(t, '->', inferCategoryFromFilename(t), '| basename:', inferCategoryFromFilename(basename));
}
