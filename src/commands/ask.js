const rv = require('ruvector');
const { LLM_MODEL, LLM_BASE_URL, resolveIndex } = require('../config');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer } = require('../llm/rag');
const { ConversationMemory } = require('../memory/conversation-memory');

async function ask(query, k = 8, indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  let index = loadIndex(paths);
  if (!index && indexName === 'Westpac') index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const hasGraph = !!index.graph;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  console.log(`LLM: ${LLM_MODEL} via ${LLM_BASE_URL}\n`);

  await rv.initOnnxEmbedder();

  const memory = new ConversationMemory(paths);
  memory.load();

  console.log(`Retrieving context for: "${query}"`);
  const { results } = await retrieve(query, index, { k, graphMode: true, memory });

  await ragAnswer(query, results, memory);
}

module.exports = { ask };
