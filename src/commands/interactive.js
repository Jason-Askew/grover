const rv = require('ruvector');
const readline = require('readline');
const { ReasoningBank, SonaCoordinator } = require('@ruvector/ruvllm');
const { LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, resolveIndex } = require('../config');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer } = require('../llm/rag');
const { formatResult } = require('../utils/formatting');
const { ConversationMemory } = require('../memory/conversation-memory');

async function interactive(indexName = null) {
  const paths = indexName ? resolveIndex(indexName) : null;
  let index = loadIndex(paths);
  if (!index && indexName === 'Westpac') index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  const hasGraph = !!index.graph;
  const hasLLM = !!LLM_API_KEY;
  const label = indexName ? ` "${indexName}"` : '';
  console.log(`Loading index${label}: ${index.records.length} chunks, ${index.dim}d${hasGraph ? ' + graph' : ''}`);
  if (hasLLM) console.log(`LLM: ${LLM_MODEL} via ${LLM_BASE_URL}`);
  else console.log(`LLM: not configured (set OPENAI_API_KEY for RAG answers)`);

  await rv.initOnnxEmbedder();

  const memory = new ConversationMemory(paths);
  memory.load();

  const uniqueFiles = new Set(index.records.map(r => r.file)).size;
  console.log(`\nReady. ${index.records.length} chunks from ${uniqueFiles} PDFs.`);
  if (hasGraph) {
    const entityCount = [...index.graph.nodes.values()].filter(
      n => n.type === 'product' || n.type === 'concept'
    ).length;
    console.log(`Knowledge graph: ${index.graph.nodes.size} nodes, ${entityCount} entities.`);
  }
  if (memory.memories.length > 0) {
    console.log(`Conversation memory: ${memory.memories.length} past interactions.`);
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
        const stats = memory.stats();
        console.log(`\n  Conversation Memory:`);
        console.log(`    Past interactions: ${stats.totalMemories}`);
        console.log(`    History messages: ${stats.historyMessages}`);
        console.log(`    SONA trajectories buffered: ${stats.sona.trajectoriesBuffered}`);
        console.log(`    SONA patterns learned: ${stats.sona.patterns.totalPatterns}`);
        if (memory.memories.length > 0) {
          console.log(`\n  Recent queries:`);
          memory.memories.slice(-5).forEach((m, i) => {
            const ts = new Date(m.timestamp).toLocaleTimeString();
            console.log(`    [${ts}] ${m.query}`);
          });
        }
        console.log();
        rl.prompt(); return;
      }

      if (input === '--forget') {
        memory.history = [];
        memory.memories = [];
        memory.reasoningBank = new ReasoningBank();
        memory.sona = new SonaCoordinator();
        memory.save();
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
      const { results, mode } = await retrieve(searchQuery, index, { k, graphMode, memory: useMemory });

      if (!hasLLM || searchOnly) {
        console.log(`\n  [${mode}]\n`);
        results.forEach((r, i) => process.stdout.write(formatResult(r, i, hasGraph && graphMode)));
      } else {
        await ragAnswer(searchQuery, results, memory);
      }

    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => { console.log('\nBye.'); process.exit(0); });
}

module.exports = { interactive };
