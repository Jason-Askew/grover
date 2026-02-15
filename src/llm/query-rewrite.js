const { LLM_API_KEY } = require('../config');
const { callLLM } = require('./client');

async function rewriteQuery(query, memory) {
  if (!memory || !LLM_API_KEY) return query;

  const recent = memory.getRecentHistory(4);
  if (recent.length === 0) return query;

  const followUpSignals = /^(what about|how about|and for|i meant|same for|that|this|it|they|those|the same|compared to|versus|vs|but for)/i;
  const isShort = query.split(/\s+/).length < 8;

  if (!isShort && !followUpSignals.test(query)) return query;

  const historyText = recent.map(h => `${h.role}: ${h.content}`).join('\n');

  try {
    const rewritten = await callLLM([
      {
        role: 'system',
        content: `You rewrite follow-up questions into standalone search queries.
Given a conversation history and a follow-up question, output ONLY the rewritten query — nothing else.
The rewritten query must be self-contained and specific enough to retrieve the right documents.
Do not explain, do not add quotes, just output the query text.`,
      },
      {
        role: 'user',
        content: `Conversation:\n${historyText}\n\nFollow-up: ${query}\n\nRewritten query:`,
      },
    ], { stream: false });

    const cleaned = rewritten.trim().replace(/^["']|["']$/g, '');
    if (cleaned && cleaned.length > 3 && cleaned.length < 200) {
      console.log(`  Query rewritten: "${query}" -> "${cleaned}"`);
      return cleaned;
    }
  } catch (e) {
    // Fall through to original query on error
  }

  return query;
}

module.exports = { rewriteQuery };
