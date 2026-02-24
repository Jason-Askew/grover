const crypto = require('crypto');
const db = require('../persistence/db');

class FeedbackIndex {
  constructor() {
    // No file I/O needed — PostgreSQL-backed
  }

  /**
   * Compute a stable content key from query + sorted source files.
   * Returns a 16-char hex string.
   */
  computeKey(query, sources) {
    const files = (sources || [])
      .map(s => s.file || s)
      .filter(Boolean)
      .sort();
    const raw = query + '|' + files.join(',');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  /**
   * Record feedback into the shared index.
   */
  async record(key, type, category, comment, userId, query) {
    const feedbackEntry = {
      type,
      category: category || null,
      comment: comment || null,
      userId: userId || null,
      query: query || null,
      timestamp: new Date().toISOString(),
    };

    // Compute new quality based on feedback type
    let qualityPenalty = 1.0;
    if (type !== 'positive') {
      if (category) {
        const qualityMap = {
          'wrong-answer-wrong-docs': 0.1,
          'wrong-answer-right-docs': 0.3,
          'right-answer-wrong-docs': 0.5,
          'incomplete-answer': 0.6,
        };
        qualityPenalty = qualityMap[category] ?? 0.3;
      } else {
        qualityPenalty = 0.3;
      }
    }

    // Upsert: insert or append feedback and update quality
    const { rows } = await db.query(
      `INSERT INTO feedback (content_key, quality, feedbacks)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (content_key) DO UPDATE SET
         feedbacks = feedback.feedbacks || $3::jsonb,
         quality = LEAST(feedback.quality, $2)
       RETURNING quality`,
      [key, qualityPenalty, JSON.stringify([feedbackEntry])]
    );

    return rows[0].quality;
  }

  /**
   * Get the shared quality score for a content key, or null if unknown.
   */
  async getQuality(key) {
    const { rows } = await db.query(
      'SELECT quality FROM feedback WHERE content_key = $1', [key]
    );
    return rows.length > 0 ? rows[0].quality : null;
  }

  async stats() {
    const { rows } = await db.query('SELECT count(*) FROM feedback');
    return { entries: parseInt(rows[0].count, 10) };
  }
}

module.exports = { FeedbackIndex };
