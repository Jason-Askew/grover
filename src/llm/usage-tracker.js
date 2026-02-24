const db = require('../persistence/db');

const MODEL_PRICING = {
  'gpt-4o-mini':  { input: 0.00015, output: 0.0006 },
  'gpt-4o':       { input: 0.0025,  output: 0.01 },
  'gpt-4-turbo':  { input: 0.01,    output: 0.03 },
};

class UsageTracker {
  constructor() {
    // No file I/O needed — PostgreSQL-backed
  }

  async record(userId, model, usage) {
    if (!usage) {
      console.log('[usage-tracker] No usage data returned by LLM');
      return;
    }
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const cost = this._estimateCost(model, prompt, completion);

    await db.query(
      `INSERT INTO usage_stats (user_id, model, prompt_tokens, completion_tokens, cost)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId || '_anonymous', model, prompt, completion, cost]
    );

    console.log(`[usage] ${userId || '_anonymous'} ${model}: ${prompt}+${completion}=${prompt + completion} tokens, $${cost.toFixed(4)}`);
  }

  async getStats() {
    const [totalsRes, byUserRes, byModelRes, recentRes] = await Promise.all([
      db.query(`SELECT
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
        COUNT(*) AS requests,
        COALESCE(SUM(cost), 0) AS estimated_cost
        FROM usage_stats`),
      db.query(`SELECT user_id,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(prompt_tokens + completion_tokens) AS total_tokens,
        COUNT(*) AS requests,
        SUM(cost) AS estimated_cost
        FROM usage_stats GROUP BY user_id`),
      db.query(`SELECT model,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(prompt_tokens + completion_tokens) AS total_tokens,
        COUNT(*) AS requests,
        SUM(cost) AS estimated_cost
        FROM usage_stats GROUP BY model`),
      db.query(`SELECT created_at AS timestamp, user_id, model, prompt_tokens, completion_tokens, cost
        FROM usage_stats ORDER BY created_at DESC LIMIT 100`),
    ]);

    const t = totalsRes.rows[0];
    const totals = {
      promptTokens: Number(t.prompt_tokens),
      completionTokens: Number(t.completion_tokens),
      totalTokens: Number(t.total_tokens),
      requests: Number(t.requests),
      estimatedCost: Number(t.estimated_cost),
    };

    const byUser = {};
    for (const r of byUserRes.rows) {
      byUser[r.user_id] = {
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens),
        requests: Number(r.requests),
        estimatedCost: Number(r.estimated_cost),
      };
    }

    const byModel = {};
    for (const r of byModelRes.rows) {
      byModel[r.model] = {
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens),
        requests: Number(r.requests),
        estimatedCost: Number(r.estimated_cost),
      };
    }

    const recent = recentRes.rows.map(r => ({
      timestamp: r.timestamp,
      userId: r.user_id,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      cost: r.cost,
    }));

    return { totals, byUser, byModel, recent };
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
