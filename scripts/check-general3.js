const { loadIndexWithFallback } = require('../src/persistence/index-persistence');
const { resolveIndex } = require('../src/config');
const { inferCategoryFromFilename } = require('../src/graph/entity-extraction');

const paths = resolveIndex('ServicesAustralia');
const index = loadIndexWithFallback(paths, 'ServicesAustralia');
const graph = index.graph;

const generalCatId = 'category:general';
let matchWithPath = 0;
let matchWithBasename = 0;

for (const [sourceId, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId && e.type === 'in_category') {
      const node = graph.nodes.get(sourceId);
      if (!node || node.type !== 'document') continue;
      const withPath = inferCategoryFromFilename(node.label);
      const basename = node.label.split('/').pop();
      const withBasename = inferCategoryFromFilename(basename);
      if (withPath) matchWithPath++;
      if (withBasename) matchWithBasename++;
    }
  }
}
console.log('Matches using full label:', matchWithPath);
console.log('Matches using basename:', matchWithBasename);
console.log('Extra docs recovered:', matchWithBasename - matchWithPath);
