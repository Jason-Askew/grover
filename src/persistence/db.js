const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgres://grover:grover@localhost:5432/grover',
      max: 20,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error('[db] Pool error:', err.message));
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function getClient() {
  return getPool().connect();
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Test connection, verify ruvector extension, and ensure all schema objects exist.
 * Safe to call on every startup — uses IF NOT EXISTS throughout.
 */
async function initDb() {
  const result = await query('SELECT extversion FROM pg_extension WHERE extname = $1', ['ruvector']);
  if (result.rows.length === 0) throw new Error('ruvector extension not installed');
  console.log(`  PostgreSQL: ruvector v${result.rows[0].extversion}`);

  await ensureSchema();
  return true;
}

/**
 * Ensure all required tables, columns, and indexes exist.
 * This is idempotent — safe to run on every startup.
 * Protects against init.sql not running (existing PG volume)
 * or schema changes between versions.
 */
async function ensureSchema() {
  const client = await getClient();
  try {
    // Run each statement individually so one failure doesn't block others
    const statements = [
      // Core data tables
      `CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        index_name TEXT NOT NULL,
        file TEXT NOT NULL,
        page_count INT,
        mtime BIGINT,
        url TEXT,
        title TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(index_name, file)
      )`,

      `CREATE TABLE IF NOT EXISTS chunks (
        id SERIAL PRIMARY KEY,
        index_name TEXT NOT NULL,
        document_id INT REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INT NOT NULL,
        total_chunks INT,
        content TEXT NOT NULL,
        preview TEXT,
        page_start INT,
        page_end INT,
        pages INT,
        embedding ruvector(384),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      `CREATE TABLE IF NOT EXISTS graphs (
        index_name TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        node_count INT DEFAULT 0,
        edge_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Session and auth
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT,
        name TEXT,
        roles JSONB DEFAULT '[]',
        created_at BIGINT NOT NULL,
        ttl BIGINT NOT NULL
      )`,

      // Chat
      `CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        index_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        is_active BOOLEAN DEFAULT false
      )`,

      `CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources JSONB,
        memory_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Memory (with vector embedding for HNSW similarity search)
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        answer TEXT NOT NULL,
        sources JSONB,
        embedding ruvector(384),
        quality FLOAT DEFAULT 1.0,
        feedback JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Feedback and usage
      `CREATE TABLE IF NOT EXISTS feedback (
        content_key TEXT PRIMARY KEY,
        quality FLOAT DEFAULT 1.0,
        feedbacks JSONB DEFAULT '[]'
      )`,

      `CREATE TABLE IF NOT EXISTS usage_stats (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INT DEFAULT 0,
        completion_tokens INT DEFAULT 0,
        cost FLOAT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Indexes
      `CREATE INDEX IF NOT EXISTS chunks_index_name_idx ON chunks (index_name)`,
      `CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id)`,
      `CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions (created_at)`,
      `CREATE INDEX IF NOT EXISTS chats_user_idx ON chats (index_name, user_id)`,
      `CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages (chat_id)`,
      `CREATE INDEX IF NOT EXISTS memories_chat_idx ON memories (chat_id)`,
      `CREATE INDEX IF NOT EXISTS usage_stats_user_idx ON usage_stats (user_id)`,
      `CREATE INDEX IF NOT EXISTS usage_stats_model_idx ON usage_stats (model)`,
    ];

    for (const sql of statements) {
      try {
        await client.query(sql);
      } catch (e) {
        console.error(`  [schema] Warning: ${e.message.split('\n')[0]}`);
      }
    }

    // tsv generated column (can't use IF NOT EXISTS for ALTER TABLE ADD COLUMN)
    try {
      const tsvCheck = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'chunks' AND column_name = 'tsv'`
      );
      if (tsvCheck.rows.length === 0) {
        await client.query(
          `ALTER TABLE chunks ADD COLUMN tsv tsvector
           GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`
        );
      }
    } catch (e) {
      console.error(`  [schema] Warning (tsv): ${e.message.split('\n')[0]}`);
    }

    // HNSW and GIN indexes (may fail if already exist — that's fine)
    const specialIndexes = [
      `CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks
        USING hnsw (embedding ruvector_cosine_ops)
        WITH (m = 16, ef_construction = 200)`,
      `CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin(tsv)`,
      `CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
        USING hnsw (embedding ruvector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`,
    ];

    for (const sql of specialIndexes) {
      try {
        await client.query(sql);
      } catch (e) {
        console.error(`  [schema] Warning (index): ${e.message.split('\n')[0]}`);
      }
    }

  } finally {
    client.release();
  }
}

module.exports = { getPool, query, getClient, closePool, initDb };
