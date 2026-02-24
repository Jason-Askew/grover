const rv = require('ruvector');
const { LLM_MODEL, LLM_BASE_URL } = require('../config');
const { initDb } = require('../persistence/db');
const db = require('../persistence/db');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer } = require('../llm/rag');
const { ConversationMemory } = require('../memory/conversation-memory');

async function ask(query, k = 8, indexName = null) {
  await initDb();

  const index = await loadIndex(null, indexName);
  if (!index) { console.log('No index found. Run: node grover.js ingest'); return; }

  const hasGraph = !!index.graph;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  console.log(`  HNSW: active (PostgreSQL ruvector)`);
  console.log(`LLM: ${LLM_MODEL} via ${LLM_BASE_URL}\n`);

  await rv.initOnnxEmbedder();

  // Create a temporary chat for the ask command
  const chatId = `ask-${Date.now()}`;
  await db.query(
    `INSERT INTO chats (id, index_name, user_id, title, is_active)
     VALUES ($1, $2, '_anonymous', 'CLI Ask', true)`,
    [chatId, indexName || 'default']
  );
  const memory = new ConversationMemory(chatId);

  console.log(`Retrieving context for: "${query}"`);
  const { results, queryVec } = await retrieve(query, index, { k, graphMode: true, memory, indexName });

  await ragAnswer(query, results, memory, { queryVec, domain: indexName });

  // Clean up temporary chat
  await db.query('DELETE FROM chats WHERE id = $1', [chatId]);
}

module.exports = { ask };
