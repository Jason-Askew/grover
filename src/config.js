const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(PROJECT_ROOT, 'corpus');
const INDEX_DIR = path.join(PROJECT_ROOT, 'index');

// PostgreSQL
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://grover:grover@localhost:5432/grover';

const LLM_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const POLLY_REGION = process.env.AWS_REGION || 'ap-southeast-2';
const POLLY_VOICE = process.env.POLLY_VOICE || 'Olivia';
const POLLY_ENGINE = process.env.POLLY_ENGINE || 'neural';

// Keycloak OIDC — set KEYCLOAK_URL to enable authentication (empty = disabled)
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || '';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'grover';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'grover-web';
const AUTH_SESSION_TTL = parseInt(process.env.AUTH_SESSION_TTL, 10) || 86400000; // 24h
const KEYCLOAK_PUBLIC_URL = process.env.KEYCLOAK_PUBLIC_URL || KEYCLOAK_URL;
const KEYCLOAK_ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER || 'admin';
const KEYCLOAK_ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

function resolveIndex(name) {
  const indexDir = path.join(INDEX_DIR, name);
  return {
    name,
    docsDir: path.join(DOCS_DIR, name),
    indexDir,
  };
}

function listIndexes() {
  const indexes = [];
  if (!fs.existsSync(INDEX_DIR)) return indexes;

  for (const entry of fs.readdirSync(INDEX_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      indexes.push(entry.name);
    }
  }

  return indexes;
}

/**
 * List indexes from PostgreSQL (used when DATABASE_URL is set).
 */
async function listIndexesPg() {
  const db = require('./persistence/db');
  const { rows } = await db.query('SELECT DISTINCT index_name FROM documents ORDER BY index_name');
  return rows.map(r => r.index_name);
}

module.exports = {
  DOCS_DIR, INDEX_DIR,
  DATABASE_URL,
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, POLLY_REGION, POLLY_VOICE, POLLY_ENGINE,
  KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, AUTH_SESSION_TTL,
  KEYCLOAK_PUBLIC_URL, KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD,
  CORS_ORIGIN,
  resolveIndex, listIndexes, listIndexesPg,
};
