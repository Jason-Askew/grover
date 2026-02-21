# Grover Implementation Plan

## Code Review Findings & Remediation

Based on a comprehensive review of all 28 source files (~3,900 lines). Issues are grouped by priority and ordered for implementation within each group.

---

## Phase 1: Security Fixes (Critical)

### 1.1 Fix Command Injection in PDF Extraction

**File**: `src/utils/pdf.js:12`

**Problem**: `filePath` is interpolated directly into a shell command via `execSync`. A filename containing shell metacharacters (quotes, backticks, `$()`) could execute arbitrary commands.

```js
// CURRENT (vulnerable)
const result = execSync(`python3 -c '${script}' "${filePath}"`, { ... });
```

**Fix**: Replace `execSync` with `execFileSync` using an argument array, which bypasses shell interpretation entirely.

```js
// FIXED
const { execFileSync } = require('child_process');
const result = execFileSync('python3', ['-c', script, filePath], {
  maxBuffer: 50 * 1024 * 1024,
  encoding: 'utf-8',
});
```

**Files changed**: `src/utils/pdf.js`
**Risk**: Low (drop-in replacement, same behaviour)

---

### 1.2 Fix XSS in Document Viewer

**File**: `graph-viz.html:991`

**Problem**: `node.meta.url` is injected directly into `innerHTML`. A crafted URL (e.g. `javascript:alert(1)` or containing HTML tags) could execute arbitrary JS.

```js
// CURRENT (vulnerable)
document.getElementById('doc-viewer-url').innerHTML =
  `<a href="${node.meta.url}" target="_blank">${node.meta.url} ...</a>`;
```

**Fix**: Use DOM APIs (`createElement`, `setAttribute`, `textContent`) instead of string interpolation into innerHTML.

```js
// FIXED
const urlEl = document.getElementById('doc-viewer-url');
urlEl.innerHTML = '';
if (node.meta?.url) {
  const a = document.createElement('a');
  a.href = node.meta.url;
  a.target = '_blank';
  a.textContent = node.meta.url + ' \u2197';
  urlEl.appendChild(a);
}
```

Also audit and fix `chat-panel.html:395` where `data-url` attributes are built via string concatenation.

**Files changed**: `graph-viz.html`, `src/server/chat-panel.html`
**Risk**: Low (visual output identical)

---

### 1.3 Add Request Body Size Limit

**File**: `src/commands/serve.js:52-58`

**Problem**: `readBody()` accumulates unlimited request data. A malicious client could exhaust server memory.

**Fix**: Add a size cap to the body reader.

```js
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
```

**Files changed**: `src/commands/serve.js`
**Risk**: Low (1MB is generous for JSON query payloads)

---

## Phase 2: Performance Optimisations (High)

### 2.1 Add Record Lookup Map in Graph Expansion

**File**: `src/graph/knowledge-graph.js:244`

**Problem**: `allRecords.find(rec => rec.id === neighbor.id)` is O(n) per call, invoked inside nested loops during every search query. With 1000+ records this becomes the bottleneck.

**Fix**: Build a `Map<id, record>` at the start of `expandResults` and use it for O(1) lookups.

```js
expandResults(vectorResults, allRecords, k = 10) {
  const recordMap = new Map(allRecords.map(r => [r.id, r]));
  // ...
  // Replace: const record = allRecords.find(rec => rec.id === neighbor.id);
  // With:    const record = recordMap.get(neighbor.id);
}
```

**Files changed**: `src/graph/knowledge-graph.js`
**Risk**: None (pure optimisation, identical output)

---

### 2.2 Add Reverse Chunk-to-Doc Map in Viz Builder

**File**: `src/server/viz-builder.js:31-36`

**Problem**: `findDocForChunk(chunkId)` iterates all `docChunks` entries for every chunk reference. Called inside the main edge loop, making it O(edges * docs * chunksPerDoc).

**Fix**: Build a reverse map once at the top of `buildVizData`.

```js
function buildVizData(graph) {
  if (!graph) return { nodes: [], edges: [] };

  // Build reverse lookup: chunkId -> "doc:<file>"
  const chunkToDoc = new Map();
  for (const [file, chunks] of graph.docChunks) {
    const docId = `doc:${file}`;
    for (const cId of chunks) chunkToDoc.set(cId, docId);
  }

  // Replace findDocForChunk(id) calls with chunkToDoc.get(id)
  // ...
}
```

**Files changed**: `src/server/viz-builder.js`
**Risk**: None (pure optimisation)

---

### 2.3 Pass Query Embedding Through Retrieve to RAG

**Files**: `src/retrieval/retrieve.js:9`, `src/llm/rag.js:46`

**Problem**: The query is embedded via ONNX twice per RAG request: once in `retrieve()` and again in `ragAnswer()` for memory lookup. ONNX inference is the most expensive local operation.

**Fix**: Return the query embedding from `retrieve()` and pass it into `ragAnswer()`.

```js
// retrieve.js - return queryVec
async function retrieve(query, index, { k = 5, graphMode = true, memory = null } = {}) {
  const searchQuery = await rewriteQuery(query, memory);
  const result = await rv.embed(searchQuery);
  const queryVec = new Float32Array(result.embedding);
  // ... search logic ...
  return { results, path, mode, queryVec };
}

// rag.js - accept optional queryVec
async function ragAnswer(query, results, memory = null, { stream = true, queryVec = null } = {}) {
  // ...
  if (memory) {
    const emb = queryVec || new Float32Array((await rv.embed(query)).embedding);
    // use emb instead of re-embedding
  }
}
```

**Files changed**: `src/retrieval/retrieve.js`, `src/llm/rag.js`, `src/commands/ask.js`, `src/commands/interactive.js`, `src/commands/serve.js`
**Risk**: Low (callers need updating to pass `queryVec` through)

---

### 2.4 Fix Quadratic `updateStats` in Graph Viz

**File**: `graph-viz.html:940-951`

**Problem**: `allVisNodes.find(n=>n.id===e.from)` inside a `.filter()` over all edges makes `updateStats` O(nodes * edges).

**Fix**: Build an ID-to-node lookup once.

```js
// Build once after allVisNodes is created:
const visNodeById = {};
allVisNodes.forEach(n => { visNodeById[n.id] = n; });

// In updateStats:
const srcV = filterState.nodeValues[visNodeById[e.from]?.nodeType]?.[e.from];
const tgtV = filterState.nodeValues[visNodeById[e.to]?.nodeType]?.[e.to];
```

**Files changed**: `graph-viz.html`
**Risk**: None (pure optimisation)

---

## Phase 3: DRY Refactors (Medium)

### 3.1 Extract Shared SSE Stream Parser

**File**: `src/llm/client.js`

**Problem**: `callLLM` (stream mode, lines 33-63) and `callLLMStream` (lines 68-126) are ~95% identical. Both build the same fetch request, parse SSE the same way, and accumulate the response.

**Fix**: Extract a common `streamSSE(response, onToken)` helper. Refactor both functions to use it.

```js
async function streamSSE(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content || '';
        if (token) {
          fullResponse += token;
          onToken(token);
        }
      } catch (e) { /* skip malformed chunks */ }
    }
  }
  return fullResponse;
}

async function callLLM(messages, { stream = true } = {}) {
  // ... fetch setup ...
  if (!stream) { /* existing non-stream path */ }
  return streamSSE(response, token => process.stdout.write(token));
}

async function callLLMStream(messages, onToken) {
  // ... fetch setup ...
  return streamSSE(response, onToken);
}
```

Also extract the shared fetch setup (headers, body construction) into a helper.

**Files changed**: `src/llm/client.js`
**Lines saved**: ~40

---

### 3.2 Extract Viz Path Builder

**File**: `src/commands/serve.js:157-192` and `249-276`

**Problem**: Identical viz path building logic (collect cited doc nodes, brand/category/entity connections, deduplicate edges) is copy-pasted between `/api/ask` and `/api/ask-stream`.

**Fix**: Extract to a shared function, either in `serve.js` or a new `src/server/viz-path.js`.

```js
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
```

**Files changed**: `src/commands/serve.js` (or new `src/server/viz-path.js`)
**Lines saved**: ~35

---

### 3.3 Extract Shared `ragAnswer` Message Building

**File**: `src/llm/rag.js`

**Problem**: `ragAnswer` (line 25) and `ragAnswerStream` (line 107) duplicate message construction, memory lookup, memory storage, and source formatting.

**Fix**: Extract shared helpers for message building and memory storage.

```js
async function buildRagMessages(query, results, memory) {
  const context = formatContext(results);
  let memoryContext = '';
  let historyMessages = [];
  let queryEmb = null;

  if (memory) {
    const queryResult = await rv.embed(query);
    queryEmb = new Float32Array(queryResult.embedding);
    const pastInteractions = await memory.findRelevant(queryEmb, 3);
    if (pastInteractions.length > 0) {
      memoryContext = '\n\nRelevant past interactions:\n' +
        pastInteractions.map((m, i) =>
          `[Past Q${i + 1}]: ${m.query}\n[Past A${i + 1}]: ${m.answer}`
        ).join('\n\n');
    }
    const recent = memory.getRecentHistory(6);
    if (recent.length > 0) {
      historyMessages = recent.map(h => ({ role: h.role, content: h.content }));
    }
  }

  const messages = [
    { role: 'system', content: RAG_SYSTEM_PROMPT },
    ...historyMessages,
    { role: 'user', content: `Sources:\n\n${context}${memoryContext}\n\n---\n\nQuestion: ${query}` },
  ];

  return { messages, queryEmb };
}

function buildSourcesSummary(results) {
  return results.map((r, i) => ({
    index: i + 1,
    file: r.file,
    url: r.url || '',
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    score: (r.combinedScore ?? r.score ?? r.vectorScore ?? 0),
  }));
}
```

Then both `ragAnswer` and `ragAnswerStream` become thin wrappers.

**Files changed**: `src/llm/rag.js`
**Lines saved**: ~40

---

### 3.4 Extract Shared Chunking Boundary Logic

**Files**: `src/utils/pdf.js:36-47`, `src/utils/markdown.js:46-54`

**Problem**: Identical paragraph/newline/sentence boundary detection logic is duplicated.

**Fix**: Extract a shared `findChunkEnd(slice, start, maxChars)` function into `src/utils/chunking.js`.

```js
// src/utils/chunking.js
function findChunkEnd(text, start, maxChars) {
  let end = start + maxChars;
  if (end >= text.length) return text.length;

  const slice = text.slice(start, end);
  const lastPara = slice.lastIndexOf('\n\n');
  const lastNewline = slice.lastIndexOf('\n');
  const lastSentence = slice.lastIndexOf('. ');

  if (lastPara > maxChars * 0.5) return start + lastPara;
  if (lastNewline > maxChars * 0.5) return start + lastNewline;
  if (lastSentence > maxChars * 0.5) return start + lastSentence + 1;
  return end;
}

module.exports = { findChunkEnd };
```

Then both `chunkPages` and `chunkText` call `findChunkEnd`.

**Files changed**: new `src/utils/chunking.js`, `src/utils/pdf.js`, `src/utils/markdown.js`
**Lines saved**: ~15

---

### 3.5 Extract Shared Index Loading with Fallback

**Files**: `src/commands/search.js`, `src/commands/ask.js`, `src/commands/interactive.js`, `src/commands/stats.js`, `src/commands/serve.js`, `src/commands/update.js`

**Problem**: The same 3-line index-load-with-fallback pattern appears in 6 places:

```js
let index = loadIndex(paths);
if (!index && indexName === 'Westpac') index = loadIndex();
if (!index) { console.log('No index found. Run: node search.js ingest'); return; }
```

**Fix**: Add a `loadIndexWithFallback(paths, indexName)` function to `src/persistence/index-persistence.js`.

```js
function loadIndexWithFallback(paths, indexName) {
  let index = loadIndex(paths);
  if (!index && indexName === 'Westpac') index = loadIndex();
  return index;
}
```

**Files changed**: `src/persistence/index-persistence.js`, all 6 command files
**Lines saved**: ~12 (minor, but eliminates a consistency risk)

---

### 3.6 Extract Shared Markdown Renderer in Frontend

**File**: `graph-viz.html`, `src/server/chat-panel.html`

**Problem**: The same `.replace()` chain for markdown-to-HTML appears 5 times across `formatAnswer`, `addMessage`, `openDocViewer`, `openMemoryDetail`, and `openMemoryViewer`.

**Fix**: Extract a single `renderMarkdown(text)` function.

```js
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[Source (\d+)\]/g, '<strong style="color:#e67e22">[Source $1]</strong>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}
```

Place in `graph-viz.html` (before chat-panel is injected) so both files can use it.

**Files changed**: `graph-viz.html`, `src/server/chat-panel.html`
**Lines saved**: ~40

---

## Phase 4: Robustness (Medium)

### 4.1 Add LLM Request Timeout

**File**: `src/llm/client.js`

**Problem**: If the LLM API hangs, the application hangs indefinitely. No timeout or abort mechanism.

**Fix**: Add `AbortController` with a configurable timeout.

```js
async function callLLM(messages, { stream = true, timeoutMs = 60000 } = {}) {
  if (!LLM_API_KEY) throw new Error('OPENAI_API_KEY not set.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { /* ... */ },
      body: JSON.stringify({ /* ... */ }),
      signal: controller.signal,
    });
    // ... rest of function
  } finally {
    clearTimeout(timeout);
  }
}
```

**Files changed**: `src/llm/client.js`

---

### 4.2 Make RAG System Prompt Domain-Aware

**File**: `src/llm/rag.js:5-23`

**Problem**: `RAG_SYSTEM_PROMPT` hard-codes Westpac brand context (WBC, SGB, BSA, BOM). When querying a ServicesAustralia index, users get a banking persona instead of a government services one.

**Fix**: Make the system prompt a function that accepts a domain/index name.

```js
function getRagSystemPrompt(domain = 'Westpac') {
  if (domain === 'ServicesAustralia') {
    return `You are a knowledgeable government services assistant...
Brand context:
- Centrelink — income support, pensions, allowances
- Medicare — health services, PBS, safety net
- Child Support — child support assessments and payments
- myGov — digital identity and linking services
...`;
  }
  return `You are a knowledgeable financial document assistant...
Brand context:
- WBC = Westpac (the parent brand)
- SGB / STG = St.George Bank
...`;
}
```

Pass the domain through from the server/command layer.

**Files changed**: `src/llm/rag.js`, `src/commands/ask.js`, `src/commands/interactive.js`, `src/commands/serve.js`

---

### 4.3 Cap Conversation Memory Size

**File**: `src/memory/conversation-memory.js:67`

**Problem**: `this.memories.push(memory)` grows without bound. Only `this.history` is capped at 100 entries. With heavy usage, memory search becomes slow and the JSON file grows large.

**Fix**: Add a cap and evict oldest entries.

```js
const MAX_MEMORIES = 200;

async store(query, answer, sources, queryEmbedding) {
  // ... existing logic ...
  this.memories.push(memory);

  // Evict oldest if over limit
  if (this.memories.length > MAX_MEMORIES) {
    this.memories = this.memories.slice(-MAX_MEMORIES);
  }

  // ... rest of method
}
```

**Files changed**: `src/memory/conversation-memory.js`

---

### 4.4 Add Graceful Server Shutdown

**File**: `src/commands/serve.js`

**Problem**: No SIGTERM/SIGINT handler. In-flight requests are dropped on Ctrl+C.

**Fix**: Add shutdown handlers after `server.listen`.

```js
server.listen(port, () => {
  console.log(`  Graph + Chat server running at http://localhost:${port}`);
  // ...
});

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // force after 5s
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**Files changed**: `src/commands/serve.js`

---

### 4.5 Handle Client Disconnect on SSE Streams

**File**: `src/commands/serve.js:208-293`

**Problem**: If a client disconnects mid-stream, the server continues processing the LLM response and writing to the closed connection.

**Fix**: Listen for `req.on('close')` and propagate cancellation.

```js
if (req.method === 'POST' && req.url === '/api/ask-stream') {
  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });

  // In the ragAnswerStream callback:
  const { answer } = await ragAnswerStream(query, results, currentMemory, (token) => {
    if (clientDisconnected) return;
    res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
  });
  // ...
}
```

**Files changed**: `src/commands/serve.js`

---

## Phase 5: Project Hygiene (Low)

### 5.1 Fix `package.json`

**File**: `package.json`

**Changes**:
- Rename `"name"` from `"ruvector-project"` to `"grover"`
- Change `"main"` from `"index.js"` to `"search.js"`
- Add `"bin": { "grover": "./search.js" }`
- Audit `cheerio` and `turndown` — if unused, remove from dependencies
- Add `"description"` field

---

### 5.2 Fix `parseInt` Without Radix

**File**: `search.js:22`

```js
// CURRENT
return parseInt(args.find((_, i) => args[i - 1] === '--k') || String(def));

// FIXED
return parseInt(args.find((_, i) => args[i - 1] === '--k') || String(def), 10);
```

**Files changed**: `search.js`

---

### 5.3 Use Absolute Paths in Config

**File**: `src/config.js:4-5`

**Problem**: `'./corpus'` and `'./index'` resolve relative to CWD, not project root. Breaks if run from another directory.

**Fix**:

```js
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(PROJECT_ROOT, 'corpus');
const INDEX_DIR = path.join(PROJECT_ROOT, 'index');
```

Also update `resolveIndex` to use `PROJECT_ROOT`.

**Files changed**: `src/config.js`

---

### 5.4 Add Word Boundary to Entity Extraction

**File**: `src/graph/entity-extraction.js:25-29`

**Problem**: Substring matching causes false positives (e.g. "margin" matches "marginally").

**Fix**: Use word boundary regex.

```js
for (const product of d.products) {
  const pattern = new RegExp(`\\b${product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (pattern.test(text)) entities.add(`product:${product}`);
}
```

Note: Pre-compile the regexes once per domain (not per call) for performance.

**Files changed**: `src/graph/entity-extraction.js`

---

### 5.5 Consolidate `findPdfs` and `findMarkdownFiles`

**File**: `src/utils/file-discovery.js`

**Problem**: Two nearly identical recursive functions differing only in file extension.

**Fix**: Single generic function.

```js
function findFiles(dir, extension) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...findFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

const findPdfs = (dir) => findFiles(dir, '.pdf');
const findMarkdownFiles = (dir) => findFiles(dir, '.md');

module.exports = { findFiles, findPdfs, findMarkdownFiles };
```

Export both the generic and specific versions for backward compatibility.

**Files changed**: `src/utils/file-discovery.js`

---

### 5.6 Improve Silent Error Handling

**Files**: `src/llm/client.js:59`, `src/commands/stats.js:68`, `src/llm/query-rewrite.js:37`

**Problem**: Empty `catch` blocks swallow errors silently, making bugs hard to diagnose.

**Fix**: Add debug-level logging. Use a simple debug flag via environment variable.

```js
const DEBUG = process.env.GROVER_DEBUG === '1';

// In catch blocks:
catch (e) {
  if (DEBUG) console.error('[debug] SSE parse error:', e.message);
}
```

**Files changed**: `src/llm/client.js`, `src/commands/stats.js`, `src/llm/query-rewrite.js`

---

### 5.7 Cache Float32Array Conversions in Memory

**File**: `src/memory/conversation-memory.js:91`

**Problem**: `findRelevant` creates a new `Float32Array` from each memory's embedding array on every call.

**Fix**: Cache the typed arrays during `load()`.

```js
load() {
  if (this.loaded) return;
  if (fs.existsSync(this._memoryFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(this._memoryFile, 'utf-8'));
      this.history = data.history || [];
      this.memories = (data.memories || []).map(m => ({
        ...m,
        _cachedEmbedding: m.embedding ? new Float32Array(m.embedding) : null,
      }));
      // ...
    }
  }
}

async findRelevant(queryEmbedding, k = 3) {
  // Use m._cachedEmbedding instead of new Float32Array(m.embedding)
}
```

**Files changed**: `src/memory/conversation-memory.js`

---

## Implementation Order Summary

| Phase | Items | Est. Lines Changed | Dependency |
|-------|-------|--------------------|------------|
| **1: Security** | 1.1, 1.2, 1.3 | ~30 | None |
| **2: Performance** | 2.1, 2.2, 2.3, 2.4 | ~60 | None |
| **3: DRY** | 3.1-3.6 | ~180 (net reduction ~180) | 2.3 before 3.3 |
| **4: Robustness** | 4.1-4.5 | ~80 | 3.1 before 4.1 |
| **5: Hygiene** | 5.1-5.7 | ~60 | None |

**Total estimated net change**: ~230 lines added, ~180 lines removed.

Phases 1 and 2 are independent and can be done in parallel. Phase 3.3 depends on 2.3 (pass-through embedding). Phase 4.1 benefits from 3.1 (shared stream helper). Phase 5 is fully independent.

---

## Files Affected (Complete List)

| File | Phases |
|------|--------|
| `src/utils/pdf.js` | 1.1, 3.4 |
| `graph-viz.html` | 1.2, 2.4, 3.6 |
| `src/server/chat-panel.html` | 1.2, 3.6 |
| `src/commands/serve.js` | 1.3, 2.3, 3.2, 4.2, 4.4, 4.5 |
| `src/graph/knowledge-graph.js` | 2.1 |
| `src/server/viz-builder.js` | 2.2 |
| `src/retrieval/retrieve.js` | 2.3 |
| `src/llm/rag.js` | 2.3, 3.3, 4.2 |
| `src/llm/client.js` | 3.1, 4.1, 5.6 |
| `src/utils/markdown.js` | 3.4 |
| `src/persistence/index-persistence.js` | 3.5 |
| `src/commands/search.js` | 3.5 |
| `src/commands/ask.js` | 2.3, 3.5, 4.2 |
| `src/commands/interactive.js` | 2.3, 3.5, 4.2 |
| `src/commands/stats.js` | 3.5, 5.6 |
| `src/commands/update.js` | 3.5 |
| `src/memory/conversation-memory.js` | 4.3, 5.7 |
| `search.js` | 5.2 |
| `src/config.js` | 5.3 |
| `src/graph/entity-extraction.js` | 5.4 |
| `src/utils/file-discovery.js` | 5.5 |
| `src/llm/query-rewrite.js` | 5.6 |
| `package.json` | 5.1 |
| `src/utils/chunking.js` (new) | 3.4 |
