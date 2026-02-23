const fs = require('fs');
const path = require('path');
const { ReasoningBank, SonaCoordinator, TrajectoryBuilder } = require('@ruvector/ruvllm');
const { INDEX_DIR, MEMORY_FILE, LLM_MODEL } = require('../config');
const { cosineSim } = require('../utils/math');

const MAX_MEMORIES = 200;

class ConversationMemory {
  /**
   * @param {object|null} paths - index paths (indexDir, memoryFile)
   * @param {object} [opts] - { userId, feedbackIndex }
   */
  constructor(paths = null, opts = {}) {
    this.reasoningBank = new ReasoningBank();
    this.sona = new SonaCoordinator();
    this.history = [];
    this.memories = [];
    this.loaded = false;
    this._userId = opts.userId || null;
    this._feedbackIndex = opts.feedbackIndex || null;

    const baseIndexDir = paths ? paths.indexDir : INDEX_DIR;

    if (opts.memoryFile) {
      // Explicit memory file override (used by ChatManager for per-chat files)
      this._memoryFile = opts.memoryFile;
      this._indexDir = path.dirname(opts.memoryFile);
    } else if (this._userId && this._userId !== '_anonymous') {
      // Per-user memory directory
      const userDir = path.join(baseIndexDir, 'users', this._userId);
      this._indexDir = userDir;
      this._memoryFile = path.join(userDir, 'memory.json');
    } else {
      this._indexDir = baseIndexDir;
      this._memoryFile = paths ? paths.memoryFile : MEMORY_FILE;
    }
  }

  load() {
    if (this.loaded) return;
    if (fs.existsSync(this._memoryFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this._memoryFile, 'utf-8'));
        this.history = data.history || [];
        this.memories = data.memories || [];

        for (const mem of this.memories) {
          if (mem.embedding) {
            mem._cachedEmbedding = new Float32Array(mem.embedding);
            this.reasoningBank.store('qa', mem._cachedEmbedding);
          }
        }
        console.log(`  Memory loaded: ${this.memories.length} past interactions, ${this.history.length} messages`);
      } catch (e) {
        console.log(`  Memory load error: ${e.message}`);
      }
    }
    this.loaded = true;
  }

  save() {
    if (!fs.existsSync(this._indexDir)) fs.mkdirSync(this._indexDir, { recursive: true });
    const data = {
      history: this.history.slice(-100),
      memories: this.memories.map(m => {
        const { _cachedEmbedding, ...rest } = m;
        return { ...rest, embedding: m.embedding ? Array.from(m.embedding) : null };
      }),
    };
    fs.writeFileSync(this._memoryFile, JSON.stringify(data));
  }

  async store(query, answer, sources, queryEmbedding) {
    const idPrefix = this._userId && this._userId !== '_anonymous'
      ? this._userId.slice(0, 8) + '-' : '';
    const memory = {
      id: `mem-${idPrefix}${Date.now()}`,
      query,
      answer,
      sources: sources.map((s, i) => ({
        index: s.index || i + 1,
        file: s.file,
        url: s.url || '',
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
        score: s.combinedScore ?? s.score ?? s.vectorScore ?? 0,
      })),
      embedding: Array.from(queryEmbedding),
      _cachedEmbedding: queryEmbedding,
      timestamp: new Date().toISOString(),
      quality: 1.0,
    };

    this.memories.push(memory);

    // Cap memory size to prevent unbounded growth
    if (this.memories.length > MAX_MEMORIES) {
      this.memories = this.memories.slice(-MAX_MEMORIES);
    }

    this.reasoningBank.store('qa', queryEmbedding);

    this.history.push({ role: 'user', content: query, timestamp: memory.timestamp });
    this.history.push({
      role: 'assistant', content: answer, timestamp: memory.timestamp,
      sources: memory.sources, memoryId: memory.id,
    });

    const tb = new TrajectoryBuilder();
    const s1 = tb.startStep('retrieval', { query, sourcesCount: sources.length });
    tb.endStep(s1, { topScore: sources[0]?.score ?? 0 });
    const s2 = tb.startStep('generation', { model: LLM_MODEL });
    tb.endStep(s2, { answerLength: answer.length });
    const trajectory = tb.complete(0.85);
    this.sona.recordTrajectory(trajectory);

    this.save();
    return memory.id;
  }

  recordFeedback(memoryId, type, category = null, comment = null) {
    const mem = this.memories.find(m => m.id === memoryId);
    if (!mem) return null;

    mem.feedback = {
      type,
      category: category || null,
      comment: comment || null,
      timestamp: new Date().toISOString(),
    };

    if (type === 'positive') {
      mem.quality = 1.0;
    } else if (category) {
      const qualityMap = {
        'wrong-answer-wrong-docs': 0.1,
        'wrong-answer-right-docs': 0.3,
        'right-answer-wrong-docs': 0.5,
        'incomplete-answer': 0.6,
      };
      mem.quality = qualityMap[category] ?? 0.3;
    } else {
      mem.quality = 0.3;
    }

    // Write to shared feedback index if available
    if (this._feedbackIndex && mem.query && mem.sources) {
      const key = this._feedbackIndex.computeKey(mem.query, mem.sources);
      this._feedbackIndex.record(key, type, category, comment, this._userId, mem.query);
    }

    // Record feedback trajectory in SONA for pattern learning
    const tb = new TrajectoryBuilder();
    const step = tb.startStep('feedback', { memoryId, type, category });
    tb.endStep(step, { newQuality: mem.quality });
    const trajectory = tb.complete(mem.quality);
    this.sona.recordTrajectory(trajectory);

    this.save();
    return mem.quality;
  }

  async findRelevant(queryEmbedding, k = 3) {
    if (this.memories.length === 0) return [];

    const scored = this.memories.map((mem, i) => {
      const memEmb = mem._cachedEmbedding || (mem.embedding ? new Float32Array(mem.embedding) : null);
      if (!memEmb) return { index: i, score: 0 };
      const sim = cosineSim(queryEmbedding, memEmb);
      let quality = mem.quality ?? 1.0;

      // Check shared feedback index for cross-user quality signals
      if (this._feedbackIndex && mem.query && mem.sources) {
        const key = this._feedbackIndex.computeKey(mem.query, mem.sources);
        const sharedQuality = this._feedbackIndex.getQuality(key);
        if (sharedQuality !== null) {
          quality = Math.min(quality, sharedQuality);
        }
      }

      return { index: i, score: sim * quality };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, k)
      .filter(s => s.score > 0.5)
      .map(s => ({
        ...this.memories[s.index],
        similarity: s.score,
      }));
  }

  getRecentHistory(n = 6) {
    return this.history.slice(-n);
  }

  stats() {
    return {
      totalMemories: this.memories.length,
      historyMessages: this.history.length,
      sona: this.sona.stats(),
    };
  }
}

module.exports = { ConversationMemory };
