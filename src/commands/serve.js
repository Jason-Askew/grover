const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ReasoningBank, SonaCoordinator } = require('@ruvector/ruvllm');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { LLM_MODEL, LLM_BASE_URL, POLLY_REGION, POLLY_VOICE, POLLY_ENGINE, resolveIndex, listIndexes } = require('../config');
const { loadIndex, loadIndexWithFallback } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer, ragAnswerStream } = require('../llm/rag');
const { ConversationMemory } = require('../memory/conversation-memory');
const { buildVizData } = require('../server/viz-builder');

async function serve(port = 3000, indexName = null) {
  const available = listIndexes();
  if (available.length === 0 && !indexName) {
    console.log('No indexes found. Run: node search.js ingest --index <name>');
    return;
  }

  const activeName = indexName || available[0];
  const paths = resolveIndex(activeName);

  let index = loadIndexWithFallback(paths, activeName);
  if (!index) {
    console.log(`No index found for "${activeName}". Run: node search.js ingest --index ${activeName}`);
    return;
  }

  console.log(`Loading index "${activeName}": ${index.records.length} chunks, ${index.dim}d${index.graph ? ' + graph' : ''}`);
  await rv.initOnnxEmbedder();

  // Mutable server state
  let currentName = activeName;
  let currentIndex = index;
  let currentMemory = new ConversationMemory(paths);
  currentMemory.load();
  let currentVizData = buildVizData(currentIndex.graph);

  const htmlPath = path.join(__dirname, '..', '..', 'graph-viz.html');
  if (!fs.existsSync(htmlPath)) {
    console.log('graph-viz.html not found in project root. Cannot serve.');
    return;
  }

  const chatPanelHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-panel.html'), 'utf-8');

  function readBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > maxBytes) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  function buildCitedVizPath(graph, sources) {
    if (!graph) return null;
    const citedFiles = new Set(sources.map(s => s.file));
    const citedDocIds = new Set([...citedFiles].map(f => `doc:${f}`));
    if (citedDocIds.size === 0) return null;

    const pathNodes = new Set();
    const pathEdges = [];

    for (const docId of citedDocIds) {
      if (!graph.nodes.has(docId)) continue;
      pathNodes.add(docId);
      const edges = graph.edges.get(docId) || [];
      for (const edge of edges) {
        const targetNode = graph.nodes.get(edge.target);
        if (!targetNode) continue;
        if (['brand', 'category', 'product', 'concept'].includes(targetNode.type)) {
          pathNodes.add(edge.target);
          pathEdges.push({ source: docId, target: edge.target, type: edge.type });
        }
        if (targetNode.type === 'document' && citedDocIds.has(edge.target)) {
          pathEdges.push({ source: docId, target: edge.target, type: edge.type });
        }
      }
    }

    const edgeSet = new Set();
    const uniqueEdges = pathEdges.filter(e => {
      const k = `${e.source}|${e.target}|${e.type}`;
      if (edgeSet.has(k)) return false;
      edgeSet.add(k);
      return true;
    });

    return { nodes: [...pathNodes], edges: uniqueEdges };
  }

  const polly = new PollyClient({ region: POLLY_REGION });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      let html = fs.readFileSync(htmlPath, 'utf-8');
      const dataJson = JSON.stringify(currentVizData);
      html = html.replace(
        'tryLoadData();',
        `initGraph(${dataJson});document.getElementById('loading').classList.add('hidden');`
      );
      html = html.replace('</body>', chatPanelHtml + '</body>');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/indexes') {
      const indexes = listIndexes().map(name => {
        const p = resolveIndex(name);
        const idx = loadIndexWithFallback(p, name);
        return {
          name,
          chunks: idx ? idx.records.length : 0,
          hasGraph: idx ? !!idx.graph : false,
          active: name === currentName,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(indexes));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/switch') {
      const body = await readBody(req);
      try {
        const { index: newName } = JSON.parse(body);
        if (!newName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing index name' }));
          return;
        }

        const newPaths = resolveIndex(newName);
        const newIndex = loadIndexWithFallback(newPaths, newName);
        if (!newIndex) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Index "${newName}" not found` }));
          return;
        }

        currentName = newName;
        currentIndex = newIndex;
        currentMemory = new ConversationMemory(newPaths);
        currentMemory.load();
        currentVizData = buildVizData(currentIndex.graph);

        console.log(`[switch] Now using index "${currentName}": ${currentIndex.records.length} chunks`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: currentName, vizData: currentVizData }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ask') {
      const body = await readBody(req);
      try {
        const { query } = JSON.parse(body);
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing query' }));
          return;
        }

        console.log(`[ask][${currentName}] ${query}`);

        const { results, path: graphPath, mode, queryVec } = await retrieve(query, currentIndex, { k: 8, graphMode: true, memory: currentMemory });

        const { answer, sources } = await ragAnswer(query, results, currentMemory, { stream: false, queryVec, domain: currentName });

        const vizPath = buildCitedVizPath(currentIndex.graph, sources);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (vizPath) {
          console.log(`  Path: ${vizPath.nodes.length} nodes, ${vizPath.edges.length} edges`);
        }
        res.end(JSON.stringify({ answer, sources, path: vizPath, mode }));

      } catch (e) {
        console.error('[ask error]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ask-stream') {
      const body = await readBody(req);
      try {
        const { query } = JSON.parse(body);
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing query' }));
          return;
        }

        console.log(`[ask-stream][${currentName}] ${query}`);

        const { results, path: graphPath, mode, queryVec } = await retrieve(query, currentIndex, { k: 8, graphMode: true, memory: currentMemory });

        // Send SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // Send sources first
        const sources = results.map((r, i) => ({
          index: i + 1,
          file: r.file,
          url: r.url || '',
          pageStart: r.pageStart,
          pageEnd: r.pageEnd,
          score: (r.combinedScore ?? r.score ?? r.vectorScore ?? 0),
        }));
        res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

        // Detect client disconnect
        let clientDisconnected = false;
        req.on('close', () => { clientDisconnected = true; });

        // Stream answer tokens
        const { answer } = await ragAnswerStream(query, results, currentMemory, (token) => {
          if (!clientDisconnected) {
            res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
          }
        }, { queryVec, domain: currentName });

        const vizPath = buildCitedVizPath(currentIndex.graph, sources);

        // Send done event with path
        res.write(`event: done\ndata: ${JSON.stringify({ path: vizPath, mode })}\n\n`);
        res.end();

      } catch (e) {
        console.error('[ask-stream error]', e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } else {
          res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
          res.end();
        }
      }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/document?')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const file = params.get('file');
      if (!file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing file parameter' }));
        return;
      }
      const chunks = currentIndex.records.filter(r => r.file === file);
      if (chunks.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Document not found' }));
        return;
      }
      chunks.sort((a, b) => a.chunk - b.chunk);
      const text = chunks.map(c => c.text).join('\n\n');
      const meta = {
        file,
        url: chunks[0].url || '',
        title: chunks[0].title || file,
        chunks: chunks.length,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meta, text }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tts') {
      const body = await readBody(req);
      try {
        const { text } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing text' }));
          return;
        }

        const cmd = new SynthesizeSpeechCommand({
          Text: text,
          OutputFormat: 'mp3',
          VoiceId: POLLY_VOICE,
          Engine: POLLY_ENGINE,
          LanguageCode: 'en-AU',
        });
        const result = await polly.send(cmd);

        // Read the stream into a buffer
        const chunks = [];
        for await (const chunk of result.AudioStream) {
          chunks.push(chunk);
        }
        const audioBuffer = Buffer.concat(chunks);
        const audioBase64 = audioBuffer.toString('base64');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ audioContent: audioBase64 }));
      } catch (e) {
        console.error('[tts error]', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, fallback: true }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/memory') {
      const memories = (currentMemory.memories || []).map(m => ({
        id: m.id,
        query: m.query,
        answer: m.answer,
        sources: m.sources,
        timestamp: m.timestamp,
        quality: m.quality,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/forget') {
      currentMemory.history = [];
      currentMemory.memories = [];
      currentMemory.reasoningBank = new ReasoningBank();
      currentMemory.sona = new SonaCoordinator();
      currentMemory.save();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`\n  Graph + Chat server running at http://localhost:${port}`);
    console.log(`  Active index: ${currentName} (${available.length} available: ${available.join(', ')})`);
    console.log(`  LLM: ${LLM_MODEL} via ${LLM_BASE_URL}\n`);
  });

  function shutdown() {
    console.log('\nShutting down server...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    // Force exit if connections don't close within 5s
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { serve };
