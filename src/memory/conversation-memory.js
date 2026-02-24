const db = require('../persistence/db');

const MAX_MEMORIES = 200;

class ConversationMemory {
  /**
   * @param {string} chatId - The chat this memory belongs to
   * @param {object} [opts] - { userId, feedbackIndex }
   */
  constructor(chatId, opts = {}) {
    this._chatId = chatId;
    this._userId = opts.userId || null;
    this._feedbackIndex = opts.feedbackIndex || null;
  }

  async store(query, answer, sources, queryEmbedding) {
    const idPrefix = this._userId && this._userId !== '_anonymous'
      ? this._userId.slice(0, 8) + '-' : '';
    const memoryId = `mem-${idPrefix}${Date.now()}`;
    const now = new Date();

    const sourcesJson = sources.map((s, i) => ({
      index: s.index || i + 1,
      file: s.file,
      url: s.url || '',
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      score: s.combinedScore ?? s.score ?? s.vectorScore ?? 0,
    }));

    const vecString = '[' + Array.from(queryEmbedding).join(',') + ']';

    // Insert memory with embedding
    await db.query(
      `INSERT INTO memories (id, chat_id, query, answer, sources, embedding, quality, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::ruvector, $7, $8)`,
      [memoryId, this._chatId, query, answer, JSON.stringify(sourcesJson),
       vecString, 1.0, now]
    );

    // Insert chat messages (user + assistant)
    await db.query(
      `INSERT INTO chat_messages (chat_id, role, content, created_at)
       VALUES ($1, 'user', $2, $3)`,
      [this._chatId, query, now]
    );
    await db.query(
      `INSERT INTO chat_messages (chat_id, role, content, sources, memory_id, created_at)
       VALUES ($1, 'assistant', $2, $3, $4, $5)`,
      [this._chatId, answer, JSON.stringify(sourcesJson), memoryId, now]
    );

    // Cap memory size per chat
    const countRes = await db.query(
      'SELECT count(*) FROM memories WHERE chat_id = $1', [this._chatId]
    );
    const count = parseInt(countRes.rows[0].count, 10);
    if (count > MAX_MEMORIES) {
      await db.query(
        `DELETE FROM memories WHERE id IN (
           SELECT id FROM memories WHERE chat_id = $1
           ORDER BY created_at ASC LIMIT $2
         )`,
        [this._chatId, count - MAX_MEMORIES]
      );
    }

    return memoryId;
  }

  async recordFeedback(memoryId, type, category = null, comment = null) {
    const { rows } = await db.query(
      'SELECT quality FROM memories WHERE id = $1 AND chat_id = $2',
      [memoryId, this._chatId]
    );
    if (rows.length === 0) return null;

    let quality;
    if (type === 'positive') {
      quality = 1.0;
    } else if (category) {
      const qualityMap = {
        'wrong-answer-wrong-docs': 0.1,
        'wrong-answer-right-docs': 0.3,
        'right-answer-wrong-docs': 0.5,
        'incomplete-answer': 0.6,
      };
      quality = qualityMap[category] ?? 0.3;
    } else {
      quality = 0.3;
    }

    const feedbackData = {
      type,
      category: category || null,
      comment: comment || null,
      timestamp: new Date().toISOString(),
    };

    await db.query(
      'UPDATE memories SET quality = $1, feedback = $2 WHERE id = $3',
      [quality, JSON.stringify(feedbackData), memoryId]
    );

    // Write to shared feedback index if available
    if (this._feedbackIndex) {
      const memRes = await db.query(
        'SELECT query, sources FROM memories WHERE id = $1', [memoryId]
      );
      if (memRes.rows.length > 0) {
        const mem = memRes.rows[0];
        const sources = mem.sources || [];
        const key = this._feedbackIndex.computeKey(mem.query, sources);
        await this._feedbackIndex.record(key, type, category, comment, this._userId, mem.query);
      }
    }

    return quality;
  }

  async findRelevant(queryEmbedding, k = 3) {
    const vecString = '[' + Array.from(queryEmbedding).join(',') + ']';

    // HNSW vector search on memories table
    const { rows } = await db.query(
      `SELECT id, query, answer, sources, quality, feedback,
              embedding <=> $1::ruvector AS distance
       FROM memories
       WHERE chat_id = $2
       ORDER BY embedding <=> $1::ruvector
       LIMIT $3`,
      [vecString, this._chatId, k * 2] // fetch extra for quality filtering
    );

    const results = [];
    for (const r of rows) {
      let quality = r.quality ?? 1.0;

      // Check shared feedback index for cross-user quality signals
      if (this._feedbackIndex && r.query && r.sources) {
        const key = this._feedbackIndex.computeKey(r.query, r.sources);
        const sharedQuality = await this._feedbackIndex.getQuality(key);
        if (sharedQuality !== null) {
          quality = Math.min(quality, sharedQuality);
        }
      }

      // Convert distance to similarity: cosine distance = 1 - similarity
      const similarity = 1 - r.distance;
      const score = similarity * quality;

      if (score > 0.5) {
        results.push({
          id: r.id,
          query: r.query,
          answer: r.answer,
          sources: r.sources,
          quality: r.quality,
          feedback: r.feedback,
          similarity: score,
        });
      }
    }

    return results.slice(0, k);
  }

  async getRecentHistory(n = 6) {
    const { rows } = await db.query(
      `SELECT role, content, sources, memory_id, created_at AS timestamp
       FROM chat_messages
       WHERE chat_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [this._chatId, n]
    );
    // Return in chronological order
    return rows.reverse().map(r => ({
      role: r.role,
      content: r.content,
      ...(r.sources ? { sources: r.sources } : {}),
      ...(r.memory_id ? { memoryId: r.memory_id } : {}),
      timestamp: r.timestamp?.toISOString(),
    }));
  }

  async stats() {
    const [memRes, histRes] = await Promise.all([
      db.query('SELECT count(*) FROM memories WHERE chat_id = $1', [this._chatId]),
      db.query('SELECT count(*) FROM chat_messages WHERE chat_id = $1', [this._chatId]),
    ]);
    return {
      totalMemories: parseInt(memRes.rows[0].count, 10),
      historyMessages: parseInt(histRes.rows[0].count, 10),
    };
  }
}

module.exports = { ConversationMemory };
