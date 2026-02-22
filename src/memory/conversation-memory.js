const fs = require('fs');
const { ReasoningBank, SonaCoordinator, TrajectoryBuilder } = require('@ruvector/ruvllm');
const { INDEX_DIR, MEMORY_FILE, LLM_MODEL } = require('../config');
const { cosineSim } = require('../utils/math');

const MAX_MEMORIES = 200;

class ConversationMemory {
  constructor(paths = null) {
    this.reasoningBank = new ReasoningBank();
    this.sona = new SonaCoordinator();
    this.history = [];
    this.memories = [];
    this.loaded = false;
    this._indexDir = paths ? paths.indexDir : INDEX_DIR;
    this._memoryFile = paths ? paths.memoryFile : MEMORY_FILE;
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
    const memory = {
      id: `mem-${Date.now()}`,
      query,
      answer: answer.slice(0, 2000),
      sources: sources.map(s => ({
        file: s.file,
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
    this.history.push({ role: 'assistant', content: answer.slice(0, 500), timestamp: memory.timestamp });

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

  async findRelevant(queryEmbedding, k = 3) {
    if (this.memories.length === 0) return [];

    const scored = this.memories.map((mem, i) => {
      const memEmb = mem._cachedEmbedding || (mem.embedding ? new Float32Array(mem.embedding) : null);
      if (!memEmb) return { index: i, score: 0 };
      const sim = cosineSim(queryEmbedding, memEmb);
      return { index: i, score: sim };
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
