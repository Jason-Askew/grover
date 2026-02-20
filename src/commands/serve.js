const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ReasoningBank, SonaCoordinator } = require('@ruvector/ruvllm');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { LLM_MODEL, LLM_BASE_URL, POLLY_REGION, POLLY_VOICE, POLLY_ENGINE, resolveIndex, listIndexes } = require('../config');
const { loadIndex } = require('../persistence/index-persistence');
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

  // Use named index paths, falling back to legacy for "Westpac" if needed
  let index = loadIndex(paths);
  if (!index && activeName === 'Westpac') {
    index = loadIndex(); // try legacy ./index/
  }
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

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
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
        let idx = loadIndex(p);
        if (!idx && name === 'Westpac') idx = loadIndex();
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
        let newIndex = loadIndex(newPaths);
        if (!newIndex && newName === 'Westpac') newIndex = loadIndex();
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

        const { results, path: graphPath, mode } = await retrieve(query, currentIndex, { k: 8, graphMode: true, memory: currentMemory });

        const { answer, sources } = await ragAnswer(query, results, currentMemory, { stream: false });

        // Build viz path from cited sources only
        const citedFiles = new Set(sources.map(s => s.file));
        const citedDocIds = new Set([...citedFiles].map(f => `doc:${f}`));

        // Collect cited doc nodes + their brand/category/entity connections
        let vizPath = null;
        if (currentIndex.graph && citedDocIds.size > 0) {
          const pathNodes = new Set();
          const pathEdges = [];

          for (const docId of citedDocIds) {
            if (!currentIndex.graph.nodes.has(docId)) continue;
            pathNodes.add(docId);

            // Add brand, category, and entity connections for cited docs
            const edges = currentIndex.graph.edges.get(docId) || [];
            for (const edge of edges) {
              const targetNode = currentIndex.graph.nodes.get(edge.target);
              if (!targetNode) continue;
              // Include brand, category, product, concept nodes
              if (['brand', 'category', 'product', 'concept'].includes(targetNode.type)) {
                pathNodes.add(edge.target);
                pathEdges.push({ source: docId, target: edge.target, type: edge.type });
              }
              // Include edges between cited docs (e.g. semantically_similar)
              if (targetNode.type === 'document' && citedDocIds.has(edge.target)) {
                pathEdges.push({ source: docId, target: edge.target, type: edge.type });
              }
            }
          }

          // Deduplicate edges
          const edgeSet = new Set();
          const uniqueEdges = pathEdges.filter(e => {
            const k = `${e.source}|${e.target}|${e.type}`;
            if (edgeSet.has(k)) return false;
            edgeSet.add(k);
            return true;
          });

          vizPath = { nodes: [...pathNodes], edges: uniqueEdges };
        }

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

        const { results, path: graphPath, mode } = await retrieve(query, currentIndex, { k: 8, graphMode: true, memory: currentMemory });

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

        // Stream answer tokens
        const { answer } = await ragAnswerStream(query, results, currentMemory, (token) => {
          res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
        });

        // Build viz path from cited sources
        const citedFiles = new Set(sources.map(s => s.file));
        const citedDocIds = new Set([...citedFiles].map(f => `doc:${f}`));
        let vizPath = null;
        if (currentIndex.graph && citedDocIds.size > 0) {
          const pathNodes = new Set();
          const pathEdges = [];
          for (const docId of citedDocIds) {
            if (!currentIndex.graph.nodes.has(docId)) continue;
            pathNodes.add(docId);
            const edges = currentIndex.graph.edges.get(docId) || [];
            for (const edge of edges) {
              const targetNode = currentIndex.graph.nodes.get(edge.target);
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
          vizPath = { nodes: [...pathNodes], edges: uniqueEdges };
        }

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
}

module.exports = { serve };
