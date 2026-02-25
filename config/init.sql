-- Grover PostgreSQL schema (runs as 02-grover-init.sql after 01-keycloak-db.sh)
-- Keycloak DB/user creation is handled by 01-keycloak-db.sh (needs env vars for password).

-- Enable ruvector extension
CREATE EXTENSION IF NOT EXISTS ruvector;

-- Documents table
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  index_name TEXT NOT NULL,
  file TEXT NOT NULL,
  page_count INT,
  mtime BIGINT,
  url TEXT,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(index_name, file)
);

-- Chunks table with ruvector embeddings
CREATE TABLE chunks (
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
);

-- HNSW index for cosine similarity search
CREATE INDEX chunks_embedding_idx ON chunks
  USING hnsw (embedding ruvector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE INDEX chunks_index_name_idx ON chunks (index_name);
CREATE INDEX chunks_document_id_idx ON chunks (document_id);

-- Full-text search index for BM25 hybrid search
ALTER TABLE chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX chunks_tsv_idx ON chunks USING gin(tsv);

-- Knowledge graph (serialized as JSONB per index)
CREATE TABLE graphs (
  index_name TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  node_count INT DEFAULT 0,
  edge_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  roles JSONB DEFAULT '[]',
  created_at BIGINT NOT NULL,
  ttl BIGINT NOT NULL
);
CREATE INDEX sessions_created_idx ON sessions (created_at);

-- Chats
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  index_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT false
);
CREATE INDEX chats_user_idx ON chats (index_name, user_id);

-- Chat messages (history)
CREATE TABLE chat_messages (
  id SERIAL PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources JSONB,
  memory_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX chat_messages_chat_idx ON chat_messages (chat_id);

-- Conversation memories (with embeddings for similarity search)
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources JSONB,
  embedding ruvector(384),
  quality FLOAT DEFAULT 1.0,
  feedback JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX memories_chat_idx ON memories (chat_id);
CREATE INDEX memories_embedding_idx ON memories
  USING hnsw (embedding ruvector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Feedback index (cross-user content-keyed quality)
CREATE TABLE feedback (
  content_key TEXT PRIMARY KEY,
  quality FLOAT DEFAULT 1.0,
  feedbacks JSONB DEFAULT '[]'
);

-- Usage statistics
CREATE TABLE usage_stats (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  cost FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX usage_stats_user_idx ON usage_stats (user_id);
CREATE INDEX usage_stats_model_idx ON usage_stats (model);
