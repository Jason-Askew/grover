const fs = require('fs');

const MODEL_PRICING = {
  'gpt-4o-mini':  { input: 0.00015, output: 0.0006 },
  'gpt-4o':       { input: 0.0025,  output: 0.01 },
  'gpt-4-turbo':  { input: 0.01,    output: 0.03 },
};

const MAX_RECENT = 100;

class UsageTracker {
  constructor(filePath) {
    this.filePath = filePath;
    this.totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0, estimatedCost: 0 };
    this.byUser = {};
    this.byModel = {};
    this.recent = [];
    this.load();
  }

  record(userId, model, usage) {
    if (!usage) {
      console.log('[usage-tracker] No usage data returned by LLM');
      return;
    }
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const total = usage.total_tokens || (prompt + completion);
    const cost = this._estimateCost(model, prompt, completion);

    this._accumulate(this.totals, prompt, completion, total, cost);

    const uid = userId || '_anonymous';
    if (!this.byUser[uid]) this.byUser[uid] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0, estimatedCost: 0 };
    this._accumulate(this.byUser[uid], prompt, completion, total, cost);

    if (!this.byModel[model]) this.byModel[model] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0, estimatedCost: 0 };
    this._accumulate(this.byModel[model], prompt, completion, total, cost);

    this.recent.push({ timestamp: new Date().toISOString(), userId: uid, model, promptTokens: prompt, completionTokens: completion, cost });
    if (this.recent.length > MAX_RECENT) this.recent = this.recent.slice(-MAX_RECENT);

    console.log(`[usage] ${uid} ${model}: ${prompt}+${completion}=${total} tokens, $${cost.toFixed(4)}`);
    this.save();
  }

  getStats() {
    return {
      totals: this.totals,
      byUser: this.byUser,
      byModel: this.byModel,
      recent: this.recent,
    };
  }

  save() {
    try {
      const data = { totals: this.totals, byUser: this.byUser, byModel: this.byModel, recent: this.recent };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[usage-tracker] Save failed:', e.message);
    }
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data.totals) this.totals = data.totals;
        if (data.byUser) this.byUser = data.byUser;
        if (data.byModel) this.byModel = data.byModel;
        if (data.recent) this.recent = data.recent;
      }
    } catch (e) {
      console.error('[usage-tracker] Load failed:', e.message);
    }
  }

  _accumulate(target, prompt, completion, total, cost) {
    target.promptTokens += prompt;
    target.completionTokens += completion;
    target.totalTokens += total;
    target.requests += 1;
    target.estimatedCost += cost;
  }

  _estimateCost(model, promptTokens, completionTokens) {
    const envInput = process.env.LLM_COST_PER_1K_INPUT;
    const envOutput = process.env.LLM_COST_PER_1K_OUTPUT;
    if (envInput && envOutput) {
      return (promptTokens / 1000) * parseFloat(envInput) + (completionTokens / 1000) * parseFloat(envOutput);
    }
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
  }
}

module.exports = { UsageTracker };
