const rv = require('ruvector');
const readline = require('readline');
const { LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, resolveIndex } = require('../config');
const { initDb } = require('../persistence/db');
const db = require('../persistence/db');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer } = require('../llm/rag');
const { formatResult } = require('../utils/formatting');
const { ConversationMemory } = require('../memory/conversation-memory');

async function interactive(indexName = null) {
  await initDb();

  const index = await loadIndex(null, indexName);
  if (!index) { console.log('No index found. Run: node grover.js ingest'); return; }

  const hasGraph = !!index.graph;
  const hasLLM = !!LLM_API_KEY;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  console.log(`  HNSW: active (PostgreSQL ruvector)`);
  if (hasLLM) console.log(`LLM: ${LLM_MODEL} via ${LLM_BASE_URL}`);
  else console.log(`LLM: not configured (set OPENAI_API_KEY for RAG answers)`);

  await rv.initOnnxEmbedder();

  // Create a temporary chat for the interactive session
  const chatId = `interactive-${Date.now()}`;
  await db.query(
    `INSERT INTO chats (id, index_name, user_id, title, is_active)
     VALUES ($1, $2, '_anonymous', 'Interactive Session', true)`,
    [chatId, indexName || 'default']
  );
  const memory = new ConversationMemory(chatId);

  const uniqueFiles = new Set(index.records.map(r => r.file)).size;
  console.log(`\nReady. ${index.records.length} chunks from ${uniqueFiles} PDFs.`);
  if (hasGraph) {
    const entityCount = [...index.graph.nodes.values()].filter(
      n => n.type === 'product' || n.type === 'concept'
    ).length;
    console.log(`Knowledge graph: ${index.graph.nodes.size} nodes, ${entityCount} entities.`);
  }

  const memStats = await memory.stats();
  if (memStats.totalMemories > 0) {
    console.log(`Conversation memory: ${memStats.totalMemories} past interactions.`);
  }

  console.log('\nCommands:');
  if (hasLLM) {
    console.log('  <query>             Ask a question (RAG + memory)');
    console.log('  --search <query>    Show raw search results (no LLM)');
  } else {
    console.log('  <query>             Search with graph expansion');
  }
  console.log('  --flat <query>      Search without graph (vector only)');
  console.log('  --k N <query>       Return N results');
  console.log('  --related <file>    Show documents related to a file');
  console.log('  --entities          List discovered entities');
  console.log('  --memory            Show conversation memory stats');
  console.log('  --forget            Clear conversation memory');
  console.log('  quit                Exit\n');

  const prompt = hasLLM ? 'ask> ' : 'search> ';
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt,
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input || input === 'quit' || input === 'exit') { rl.close(); return; }

    try {
      if (input === '--entities') {
        if (!hasGraph) { console.log('No graph available.\n'); rl.prompt(); return; }
        const products = [];
        const concepts = [];
        for (const [id, node] of index.graph.nodes) {
          if (node.type === 'product') products.push(node.label);
          if (node.type === 'concept') concepts.push(node.label);
        }
        console.log(`\nProducts (${products.length}): ${products.sort().join(', ')}`);
        console.log(`\nConcepts (${concepts.length}): ${concepts.sort().join(', ')}\n`);
        rl.prompt(); return;
      }

      if (input === '--memory') {
        const stats = await memory.stats();
        console.log(`\n  Conversation Memory:`);
        console.log(`    Past interactions: ${stats.totalMemories}`);
        console.log(`    History messages: ${stats.historyMessages}`);
        console.log();
        rl.prompt(); return;
      }

      if (input === '--forget') {
        await db.query('DELETE FROM memories WHERE chat_id = $1', [chatId]);
        await db.query('DELETE FROM chat_messages WHERE chat_id = $1', [chatId]);
        console.log('\n  Memory cleared.\n');
        rl.prompt(); return;
      }

      if (input.startsWith('--related ')) {
        if (!hasGraph) { console.log('No graph available.\n'); rl.prompt(); return; }
        const fileQuery = input.slice(10).trim();
        const matchingFiles = [...index.graph.docChunks.keys()].filter(
          f => f.toLowerCase().includes(fileQuery.toLowerCase())
        );
        if (matchingFiles.length === 0) {
          console.log(`No files matching "${fileQuery}"\n`);
          rl.prompt(); return;
        }
        const file = matchingFiles[0];
        console.log(`\nRelated to: ${file}\n`);

        const docId = `doc:${file}`;
        const neighbors = index.graph.getNeighbors(docId, null, 2);

        const related = { documents: new Set(), products: new Set(), concepts: new Set(), brands: new Set() };
        for (const n of neighbors) {
          const node = index.graph.nodes.get(n.id);
          if (!node) continue;
          if (node.type === 'document') related.documents.add(node.label);
          else if (node.type === 'product') related.products.add(node.label);
          else if (node.type === 'concept') related.concepts.add(node.label);
          else if (node.type === 'brand') related.brands.add(node.label);
        }

        if (related.brands.size) console.log(`  Brand: ${[...related.brands].join(', ')}`);
        if (related.products.size) console.log(`  Products: ${[...related.products].join(', ')}`);
        if (related.concepts.size) console.log(`  Concepts: ${[...related.concepts].join(', ')}`);
        if (related.documents.size > 1) {
          console.log(`  Related docs:`);
          for (const d of [...related.documents].filter(d => d !== file).slice(0, 10)) {
            console.log(`    - ${d}`);
          }
        }
        console.log();
        rl.prompt(); return;
      }

      // Parse flags
      let k = hasLLM ? 8 : 5;
      let graphMode = true;
      let searchOnly = false;
      let searchQuery = input;

      const kMatch = input.match(/--k\s+(\d+)/);
      if (kMatch) {
        k = parseInt(kMatch[1]);
        searchQuery = searchQuery.replace(/--k\s+\d+/, '').trim();
      }
      if (searchQuery.startsWith('--flat ')) {
        graphMode = false;
        searchQuery = searchQuery.slice(7).trim();
      }
      if (searchQuery.startsWith('--search ')) {
        searchOnly = true;
        searchQuery = searchQuery.slice(9).trim();
      }

      const useMemory = hasLLM && !searchOnly ? memory : null;
      const { results, mode, queryVec } = await retrieve(searchQuery, index, { k, graphMode, memory: useMemory, indexName });

      if (!hasLLM || searchOnly) {
        console.log(`\n  [${mode}]\n`);
        results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph && graphMode)));
      } else {
        await ragAnswer(searchQuery, results, memory, { queryVec, domain: indexName });
      }

    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    // Clean up the temporary chat
    db.query('DELETE FROM chats WHERE id = $1', [chatId]).catch(() => {});
    console.log('\nBye.');
    process.exit(0);
  });
}

module.exports = { interactive };
