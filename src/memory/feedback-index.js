const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class FeedbackIndex {
  constructor(indexDir) {
    this._indexDir = indexDir;
    this._file = path.join(indexDir, 'feedback-index.json');
    this._data = {};
    this._load();
  }

  _load() {
    if (fs.existsSync(this._file)) {
      try {
        this._data = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
      } catch (e) {
        console.log(`  Feedback index load error: ${e.message}`);
        this._data = {};
      }
    }
  }

  _save() {
    if (!fs.existsSync(this._indexDir)) fs.mkdirSync(this._indexDir, { recursive: true });
    fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2));
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
  record(key, type, category, comment, userId, query) {
    if (!this._data[key]) {
      this._data[key] = { quality: 1.0, feedbacks: [] };
    }

    const entry = this._data[key];
    entry.feedbacks.push({
      type,
      category: category || null,
      comment: comment || null,
      userId: userId || null,
      query: query || null,
      timestamp: new Date().toISOString(),
    });

    // Recompute quality from all feedbacks
    if (type === 'positive') {
      // Positive feedback doesn't degrade quality
    } else if (category) {
      const qualityMap = {
        'wrong-answer-wrong-docs': 0.1,
        'wrong-answer-right-docs': 0.3,
        'right-answer-wrong-docs': 0.5,
        'incomplete-answer': 0.6,
      };
      const newQuality = qualityMap[category] ?? 0.3;
      entry.quality = Math.min(entry.quality, newQuality);
    } else {
      entry.quality = Math.min(entry.quality, 0.3);
    }

    this._save();
    return entry.quality;
  }

  /**
   * Get the shared quality score for a content key, or null if unknown.
   */
  getQuality(key) {
    const entry = this._data[key];
    return entry ? entry.quality : null;
  }

  stats() {
    return {
      entries: Object.keys(this._data).length,
    };
  }
}

module.exports = { FeedbackIndex };
