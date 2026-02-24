const rv = require('ruvector');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { LLM_MODEL, LLM_BASE_URL, POLLY_REGION, POLLY_VOICE, POLLY_ENGINE, CORS_ORIGIN, resolveIndex, listIndexesPg } = require('../config');
const { initDb, closePool } = require('../persistence/db');
const { loadIndex } = require('../persistence/index-persistence');
const { retrieve } = require('../retrieval/retrieve');
const { ragAnswer, ragAnswerStream } = require('../llm/rag');
const { FeedbackIndex } = require('../memory/feedback-index');
const { ChatManager } = require('../memory/chat-manager');
const { buildVizData } = require('../server/viz-builder');
const { buildCitedVizPath } = require('../server/viz-path');
const { getAuthConfig, initSessionStore, getSessionStore, handleAuthRoute, requireAuth, getSession } = require('../server/auth');
const { handleAdminRoute } = require('../server/admin-api');
const { UsageTracker } = require('../llm/usage-tracker');

async function serve(port = 3000, indexName = null) {
  // Verify PostgreSQL connection + ruvector extension
  await initDb();

  const available = await listIndexesPg();
  if (available.length === 0 && !indexName) {
    console.log('No indexes found. Run: node grover.js ingest --index <name>');
    return;
  }

  const activeName = indexName || available[0];

  let index = await loadIndex(null, activeName);
  if (!index) {
    console.log(`No index found for "${activeName}". Run: node grover.js ingest --index ${activeName}`);
    return;
  }

  console.log(`Loading index "${activeName}": ${index.records.length} chunks, ${index.dim}d${index.graph ? ' + graph' : ''}`);
  console.log(`  HNSW: active (PostgreSQL ruvector)`);
  await rv.initOnnxEmbedder();

  const authConfig = getAuthConfig();
  if (authConfig) await initSessionStore();

  // Mutable server state
  let currentName = activeName;
  let currentIndex = index;
  let feedbackIndex = new FeedbackIndex();
  let currentVizData = buildVizData(currentIndex.graph);
  const usageTracker = new UsageTracker();

  // Per-user chat managers (keyed by indexName:userId)
  const userChatManagers = new Map();

  async function getUserChatManager(userId) {
    const key = `${currentName}:${userId || '_anonymous'}`;
    if (userChatManagers.has(key)) return userChatManagers.get(key);
    const mgr = new ChatManager(currentName, userId || '_anonymous', feedbackIndex);
    await mgr.load();
    userChatManagers.set(key, mgr);
    return mgr;
  }

  const htmlPath = path.join(__dirname, '..', '..', 'graph-viz.html');
  if (!fs.existsSync(htmlPath)) {
    console.log('graph-viz.html not found in project root. Cannot serve.');
    return;
  }

  const chatPanelHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-panel.html'), 'utf-8');
  const loginOverlayHtml = authConfig
    ? fs.readFileSync(path.join(__dirname, '..', 'server', 'login-overlay.html'), 'utf-8')
    : '';

  function readBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > maxBytes) { req.destroy(); reject(new Error('Request body too large')); }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  const polly = new PollyClient({ region: POLLY_REGION });

  const server = http.createServer(async (req, res) => {
    const corsOrigin = CORS_ORIGIN || `http://localhost:${port}`;
    if (authConfig) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (await handleAuthRoute(req, res, authConfig)) return;
      if (await handleAdminRoute(req, res, authConfig, readBody, usageTracker)) return;
    } catch (e) {
      console.error('[auth route error]', e.message);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Auth error' })); }
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    // ── Health check (unauthenticated) ──
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', index: currentName, chunks: currentIndex.records.length }));
      return;
    }

    // ── HTML page ──
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html = fs.readFileSync(htmlPath, 'utf-8');
      const dataJson = JSON.stringify(currentVizData);
      html = html.replace('tryLoadData();', `initGraph(${dataJson});document.getElementById('loading').classList.add('hidden');`);

      if (authConfig) {
        const user = await getSession(req);
        if (user) {
          const isAdmin = Array.isArray(user.roles) && user.roles.includes('admin');
          const userScript = `<script>window.__USER__ = ${JSON.stringify({ name: user.name, email: user.email, isAdmin })};</script>`;
          html = html.replace('</body>', userScript + chatPanelHtml + '</body>');
        } else {
          const authClientConfig = { clientId: authConfig.clientId, authEndpoint: authConfig.authEndpoint, tokenEndpoint: authConfig.tokenEndpoint };
          const configScript = `<script>window.__AUTH_CONFIG__ = ${JSON.stringify(authClientConfig)};</script>`;
          html = html.replace('</body>', configScript + chatPanelHtml + loginOverlayHtml + '</body>');
        }
      } else {
        html = html.replace('</body>', chatPanelHtml + '</body>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // ── Index listing ──
    if (req.method === 'GET' && url.pathname === '/api/indexes') {
      const names = await listIndexesPg();
      const indexes = [];
      for (const name of names) {
        const idx = await loadIndex(null, name);
        indexes.push({
          name,
          chunks: idx ? idx.records.length : 0,
          hasGraph: idx ? !!idx.graph : false,
          active: name === currentName,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(indexes));
      return;
    }

    // ── Switch index ──
    if (req.method === 'POST' && url.pathname === '/api/switch') {
      const body = await readBody(req);
      try {
        const { index: newName } = JSON.parse(body);
        if (!newName) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing index name' })); return; }
        const newIndex = await loadIndex(null, newName);
        if (!newIndex) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Index "${newName}" not found` })); return; }

        currentName = newName;
        currentIndex = newIndex;
        feedbackIndex = new FeedbackIndex();
        userChatManagers.clear();
        currentVizData = buildVizData(currentIndex.graph);
        console.log(`[switch] Now using index "${currentName}": ${currentIndex.records.length} chunks`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: currentName, vizData: currentVizData }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Chat management ──
    if (url.pathname === '/api/chats') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const mgr = await getUserChatManager(user.userId);

      if (req.method === 'GET') {
        const chats = await mgr.listChats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chats, activeChatId: mgr.getActiveChatId() }));
        return;
      }
      if (req.method === 'POST') {
        const chat = await mgr.createChat();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chat, activeChatId: chat.id }));
        return;
      }
      if (req.method === 'DELETE') {
        const chatId = url.searchParams.get('id');
        if (!chatId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing id' })); return; }
        await mgr.deleteChat(chatId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, activeChatId: mgr.getActiveChatId() }));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/chats/rename') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const body = await readBody(req);
      const { chatId, title } = JSON.parse(body);
      if (!chatId || typeof title !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing chatId or title' })); return; }
      const mgr = await getUserChatManager(user.userId);
      if (!(await mgr.renameChat(chatId, title.trim()))) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Chat not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chats/switch') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const body = await readBody(req);
      const { chatId } = JSON.parse(body);
      const mgr = await getUserChatManager(user.userId);
      if (!(await mgr.setActiveChatId(chatId))) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Chat not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chatId }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/chats/history') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const chatId = url.searchParams.get('chatId');
      const mgr = await getUserChatManager(user.userId);
      const memory = chatId ? mgr.getMemory(chatId) : mgr.getActiveMemory();
      const history = await memory.getRecentHistory(200);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ history }));
      return;
    }

    // ── Ask (non-streaming) ──
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const mgr = await getUserChatManager(user.userId);
      const body = await readBody(req);
      try {
        const { query, chatId } = JSON.parse(body);
        if (!query) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing query' })); return; }
        const cid = chatId || mgr.getActiveChatId();
        const memory = mgr.getMemory(cid);
        await mgr.autoTitle(cid, query);
        await mgr.touchChat(cid);
        console.log(`[ask][${currentName}][${user.userId}] ${query}`);
        const { results, path: graphPath, mode, queryVec } = await retrieve(query, currentIndex, { k: 8, graphMode: true, memory, indexName: currentName });
        const { answer, sources, memoryId, usage } = await ragAnswer(query, results, memory, { stream: false, queryVec, domain: currentName });
        await usageTracker.record(user.userId, LLM_MODEL, usage);
        const vizPath = buildCitedVizPath(currentIndex.graph, sources, currentVizData);
        if (vizPath) console.log(`  Path: ${vizPath.nodes.length} nodes, ${vizPath.edges.length} edges`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer, sources, path: vizPath, mode, memoryId }));
      } catch (e) {
        console.error('[ask error]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Ask (streaming) ──
    if (req.method === 'POST' && url.pathname === '/api/ask-stream') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const mgr = await getUserChatManager(user.userId);
      const body = await readBody(req);
      try {
        const { query, chatId } = JSON.parse(body);
        if (!query) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing query' })); return; }
        const cid = chatId || mgr.getActiveChatId();
        const memory = mgr.getMemory(cid);
        await mgr.autoTitle(cid, query);
        await mgr.touchChat(cid);
        console.log(`[ask-stream][${currentName}][${user.userId}] ${query}`);
        const { results, path: graphPath, mode, queryVec } = await retrieve(query, currentIndex, { k: 8, graphMode: true, memory, indexName: currentName });

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        const sources = results.map((r, i) => ({
          index: i + 1, file: r.file, url: r.url || '', pageStart: r.pageStart, pageEnd: r.pageEnd,
          score: (r.combinedScore ?? r.score ?? r.vectorScore ?? 0),
        }));
        res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

        let clientDisconnected = false;
        req.on('close', () => { clientDisconnected = true; });

        const { answer, memoryId, usage } = await ragAnswerStream(query, results, memory, (token) => {
          if (!clientDisconnected) res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
        }, { queryVec, domain: currentName });
        await usageTracker.record(user.userId, LLM_MODEL, usage);

        const vizPath = buildCitedVizPath(currentIndex.graph, sources, currentVizData);
        res.write(`event: done\ndata: ${JSON.stringify({ path: vizPath, mode, memoryId })}\n\n`);
        res.end();
      } catch (e) {
        console.error('[ask-stream error]', e.message);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        else { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); }
      }
      return;
    }

    // ── Document viewer ──
    if (req.method === 'GET' && url.pathname === '/api/document') {
      const file = url.searchParams.get('file');
      if (!file) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing file parameter' })); return; }
      const chunks = currentIndex.records.filter(r => r.file === file);
      if (chunks.length === 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Document not found' })); return; }
      chunks.sort((a, b) => a.chunk - b.chunk);
      const text = chunks.map(c => c.text).join('\n\n');
      const meta = { file, url: chunks[0].url || '', title: chunks[0].title || file, chunks: chunks.length };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meta, text }));
      return;
    }

    // ── TTS ──
    if (req.method === 'POST' && url.pathname === '/api/tts') {
      const body = await readBody(req);
      try {
        const { text } = JSON.parse(body);
        if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing text' })); return; }
        const cmd = new SynthesizeSpeechCommand({ Text: text, OutputFormat: 'mp3', VoiceId: POLLY_VOICE, Engine: POLLY_ENGINE, LanguageCode: 'en-AU' });
        const result = await polly.send(cmd);
        const chunks = []; for await (const chunk of result.AudioStream) chunks.push(chunk);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ audioContent: Buffer.concat(chunks).toString('base64') }));
      } catch (e) {
        console.error('[tts error]', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message, fallback: true }));
      }
      return;
    }

    // ── Memory listing ──
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const mgr = await getUserChatManager(user.userId);
      const chatId = url.searchParams.get('chatId');
      const memory = chatId ? mgr.getMemory(chatId) : mgr.getActiveMemory();
      // Fetch memories from PG
      const dbMem = require('../persistence/db');
      const { rows } = await dbMem.query(
        `SELECT id, query, answer, sources, created_at AS timestamp, quality, feedback
         FROM memories WHERE chat_id = $1 ORDER BY created_at DESC`,
        [chatId || mgr.getActiveChatId()]
      );
      const memories = rows.map(m => ({
        id: m.id, query: m.query, answer: m.answer, sources: m.sources,
        timestamp: m.timestamp?.toISOString(), quality: m.quality, feedback: m.feedback || null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories }));
      return;
    }

    // ── Feedback ──
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const mgr = await getUserChatManager(user.userId);
      const body = await readBody(req);
      try {
        const { memoryId, type, category, comment, chatId } = JSON.parse(body);
        if (!memoryId || !type) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing memoryId or type' })); return; }
        const memory = chatId ? mgr.getMemory(chatId) : mgr.getActiveMemory();
        const quality = await memory.recordFeedback(memoryId, type, category || null, comment || null);
        if (quality === null) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Memory not found' })); return; }
        console.log(`[feedback][${currentName}][${user.userId}] ${memoryId} → ${type}${category ? ' (' + category + ')' : ''} quality=${quality}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, quality }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Forget (clear active chat) ──
    if (req.method === 'POST' && url.pathname === '/api/forget') {
      const user = await requireAuth(req, res, authConfig);
      if (!user) return;
      const mgr = await getUserChatManager(user.userId);
      let chatId;
      try { const body = await readBody(req); chatId = JSON.parse(body).chatId; } catch (e) { /* no body is fine */ }
      const cid = chatId || mgr.getActiveChatId();
      // Delete all memories and messages for this chat
      const dbMod = require('../persistence/db');
      await dbMod.query('DELETE FROM memories WHERE chat_id = $1', [cid]);
      await dbMod.query('DELETE FROM chat_messages WHERE chat_id = $1', [cid]);
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
    console.log(`  LLM: ${LLM_MODEL} via ${LLM_BASE_URL}`);
    if (authConfig) console.log(`  Auth: Keycloak OIDC via ${authConfig.url} (realm: ${authConfig.realm})`);
    else console.log(`  Auth: disabled (set KEYCLOAK_URL to enable)`);
    console.log();
  });

  function shutdown() {
    console.log('\nShutting down server...');
    const promises = [];
    if (authConfig) promises.push(getSessionStore().shutdown());
    promises.push(closePool());
    Promise.all(promises).catch(() => {});
    server.close(() => { console.log('Server closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 5000);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { serve };
