const path = require('path');

const DOCS_DIR = './corpus';
const INDEX_DIR = './index';
const META_FILE = path.join(INDEX_DIR, 'metadata.json');
const EMBEDDINGS_FILE = path.join(INDEX_DIR, 'embeddings.bin');
const GRAPH_FILE = path.join(INDEX_DIR, 'graph.json');
const MEMORY_FILE = path.join(INDEX_DIR, 'memory.json');

const LLM_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

module.exports = {
  DOCS_DIR, INDEX_DIR, META_FILE, EMBEDDINGS_FILE, GRAPH_FILE, MEMORY_FILE,
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
};
