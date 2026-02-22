const rv = require('ruvector');
const { formatContext } = require('../utils/formatting');
const { callLLM, callLLMStream } = require('./client');

const DOMAIN_PROMPTS = {
  Westpac: `You are a knowledgeable financial document assistant. You answer questions based on the provided source documents and conversation history.

Brand context:
The documents come from four separate banking brands under the Westpac Group. You can identify them from the file paths:
- WBC = Westpac (the parent brand)
- SGB / STG = St.George Bank
- BSA = BankSA
- BOM = Bank of Melbourne
These are separate brands with separate products and terms. Differences between them are expected and normal — not contradictions. Always attribute information to the correct brand by name.`,

  ServicesAustralia: `You are a knowledgeable government services assistant. You answer questions based on the provided source documents and conversation history.

Agency context:
The documents come from Services Australia (formerly the Department of Human Services). They cover government programs including Centrelink, Medicare, and Child Support. Be precise about eligibility criteria, payment rates, waiting periods, and reporting obligations.`,
};

const RAG_RULES = `
Rules:
- Answer the question using the information in the sources provided below.
- Cite your sources using [Source N] notation inline.
- If previous conversation context is provided, use it to understand follow-up questions and maintain continuity.
- If the sources don't contain enough information to fully answer, say what you can and note what's missing.
- Be precise with terms, amounts, dates, and conditions.
- Keep your answer clear and well-structured.
- Do not make up information that isn't in the sources.`;

function getSystemPrompt(domain) {
  const domainContext = DOMAIN_PROMPTS[domain] || DOMAIN_PROMPTS.Westpac;
  return domainContext + '\n' + RAG_RULES;
}

async function buildRagContext(query, results, memory, queryVec, domain) {
  const context = formatContext(results);

  let memoryContext = '';
  let historyMessages = [];
  let queryEmb = null;

  if (memory) {
    queryEmb = queryVec || new Float32Array((await rv.embed(query)).embedding);
    const pastInteractions = await memory.findRelevant(queryEmb, 3);

    if (pastInteractions.length > 0) {
      memoryContext = '\n\nRelevant past interactions:\n' +
        pastInteractions.map((m, i) =>
          `[Past Q${i + 1}]: ${m.query}\n[Past A${i + 1}]: ${m.answer}`
        ).join('\n\n');
    }

    const recent = memory.getRecentHistory(6);
    if (recent.length > 0) {
      historyMessages = recent.map(h => ({ role: h.role, content: h.content }));
    }
  }

  const messages = [
    { role: 'system', content: getSystemPrompt(domain) },
    ...historyMessages,
    { role: 'user', content: `Sources:\n\n${context}${memoryContext}\n\n---\n\nQuestion: ${query}` },
  ];

  return { messages, queryEmb, pastInteractions: memoryContext ? true : false };
}

function buildSourcesSummary(results) {
  return results.map((r, i) => ({
    index: i + 1,
    file: r.file,
    url: r.url || '',
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    score: (r.combinedScore ?? r.score ?? r.vectorScore ?? 0),
  }));
}

async function ragAnswer(query, results, memory = null, { stream = true, queryVec = null, domain = null } = {}) {
  // Show sources summary (only in streaming/CLI mode)
  if (stream) {
    console.log('\n  Sources:');
    results.forEach((r, i) => {
      const meta = r.file ? r : {};
      const pageLabel = meta.pageStart === meta.pageEnd
        ? `p.${meta.pageStart}` : `pp.${meta.pageStart}-${meta.pageEnd}`;
      const score = (r.combinedScore ?? r.score ?? r.vectorScore ?? 0).toFixed(4);
      console.log(`    [${i + 1}] ${meta.file || 'unknown'} (${pageLabel}) [${score}]`);
    });
  }

  const { messages, queryEmb, pastInteractions } = await buildRagContext(query, results, memory, queryVec, domain);

  if (stream && pastInteractions) {
    console.log('\n  (using relevant past interactions)');
  }

  if (stream) {
    console.log('\n  Answer:\n');
  }

  const answer = await callLLM(messages, { stream });

  if (stream) {
    console.log('\n');
  }

  if (memory && queryEmb) {
    await memory.store(query, answer, results, queryEmb);
  }

  return { answer, sources: buildSourcesSummary(results) };
}

async function ragAnswerStream(query, results, memory, onToken, { queryVec = null, domain = null } = {}) {
  const { messages, queryEmb } = await buildRagContext(query, results, memory, queryVec, domain);

  const answer = await callLLMStream(messages, onToken);

  if (memory && queryEmb) {
    await memory.store(query, answer, results, queryEmb);
  }

  return { answer, sources: buildSourcesSummary(results) };
}

module.exports = { getSystemPrompt, ragAnswer, ragAnswerStream };
