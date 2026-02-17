const path = require('path');
const fs = require('fs');

const DOCS_DIR = './corpus';
const INDEX_DIR = './index';
const META_FILE = path.join(INDEX_DIR, 'metadata.json');
const EMBEDDINGS_FILE = path.join(INDEX_DIR, 'embeddings.bin');
const GRAPH_FILE = path.join(INDEX_DIR, 'graph.json');
const MEMORY_FILE = path.join(INDEX_DIR, 'memory.json');

const LLM_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

function resolveIndex(name) {
  const indexDir = path.join('./index', name);
  return {
    name,
    docsDir: path.join('./corpus', name),
    indexDir,
    metaFile: path.join(indexDir, 'metadata.json'),
    embeddingsFile: path.join(indexDir, 'embeddings.bin'),
    graphFile: path.join(indexDir, 'graph.json'),
    memoryFile: path.join(indexDir, 'memory.json'),
  };
}

function listIndexes() {
  const indexes = [];
  const indexRoot = './index';
  if (!fs.existsSync(indexRoot)) return indexes;

  // Check for named index subdirs (contain metadata.json)
  for (const entry of fs.readdirSync(indexRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const metaPath = path.join(indexRoot, entry.name, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        indexes.push(entry.name);
      }
    }
  }

  // Legacy: if ./index/metadata.json exists but no named dirs contain it,
  // treat root index as "Westpac"
  if (indexes.length === 0 && fs.existsSync(path.join(indexRoot, 'metadata.json'))) {
    indexes.push('Westpac');
  }

  return indexes;
}

module.exports = {
  DOCS_DIR, INDEX_DIR, META_FILE, EMBEDDINGS_FILE, GRAPH_FILE, MEMORY_FILE,
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
  resolveIndex, listIndexes,
};
