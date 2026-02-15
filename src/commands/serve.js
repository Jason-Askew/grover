const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ReasoningBank, SonaCoordinator } = require('@ruvector/ruvllm');
const { LLM_MODEL, LLM_BASE_URL } = require('../config');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer } = require('../llm/rag');
const { ConversationMemory } = require('../memory/conversation-memory');
const { buildVizData } = require('../server/viz-builder');

async function serve(port = 3000) {
  const index = loadIndex();
  if (!index) { console.log('No index found. Run: node search.js ingest'); return; }

  console.log(`Loading index: ${index.records.length} chunks, ${index.dim}d${index.graph ? ' + graph' : ''}`);
  await rv.initOnnxEmbedder();

  const memory = new ConversationMemory();
  memory.load();

  const vizData = buildVizData(index.graph);

  const htmlPath = path.join(__dirname, '..', '..', 'graph-viz.html');
  if (!fs.existsSync(htmlPath)) {
    console.log('graph-viz.html not found in project root. Cannot serve.');
    return;
  }

  const chatPanelHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-panel.html'), 'utf-8');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      let html = fs.readFileSync(htmlPath, 'utf-8');
      const dataJson = JSON.stringify(vizData);
      html = html.replace(
        'tryLoadData();',
        `initGraph(${dataJson});document.getElementById('loading').classList.add('hidden');`
      );
      html = html.replace('</body>', chatPanelHtml + '</body>');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ask') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { query } = JSON.parse(body);
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing query' }));
            return;
          }

          console.log(`[ask] ${query}`);

          const { results, path: graphPath, mode } = await retrieve(query, index, { k: 8, graphMode: true, memory });

          // Use ragAnswer in non-streaming mode (eliminates duplicated RAG logic)
          const { answer, sources } = await ragAnswer(query, results, memory, { stream: false });

          // Map chunk IDs to document IDs for viz
          function chunkToDoc(id) {
            const node = index.graph?.nodes.get(id);
            if (node && node.type === 'chunk') {
              const rec = index.records.find(r => r.id === id);
              return rec ? `doc:${rec.file}` : null;
            }
            return id;
          }

          const vizPath = graphPath ? {
            nodes: [...new Set(
              graphPath.nodes
                .map(id => chunkToDoc(id))
                .filter(Boolean)
            )],
            edges: graphPath.edges
              .map(e => ({
                source: chunkToDoc(e.source),
                target: chunkToDoc(e.target),
                type: e.type,
              }))
              .filter(e => e.source && e.target && e.source !== e.target),
          } : null;

          // Deduplicate viz path edges
          if (vizPath) {
            const edgeSet = new Set();
            vizPath.edges = vizPath.edges.filter(e => {
              const k = `${e.source}|${e.target}`;
              if (edgeSet.has(k)) return false;
              edgeSet.add(k);
              return true;
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (vizPath) {
            console.log(`  Path: ${vizPath.nodes.length} nodes, ${vizPath.edges.length} edges`);
            console.log(`  Path nodes: ${vizPath.nodes.slice(0, 8).join(', ')}${vizPath.nodes.length > 8 ? '...' : ''}`);
          }
          res.end(JSON.stringify({ answer, sources, path: vizPath, mode }));

        } catch (e) {
          console.error('[ask error]', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/forget') {
      memory.history = [];
      memory.memories = [];
      memory.reasoningBank = new ReasoningBank();
      memory.sona = new SonaCoordinator();
      memory.save();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`\n  Graph + Chat server running at http://localhost:${port}`);
    console.log(`  LLM: ${LLM_MODEL} via ${LLM_BASE_URL}\n`);
  });
}

module.exports = { serve };
