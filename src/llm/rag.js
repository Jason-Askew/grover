const rv = require('ruvector');
const { formatContext } = require('../utils/formatting');
const { callLLM } = require('./client');

const RAG_SYSTEM_PROMPT = `You are a knowledgeable financial document assistant. You answer questions based on the provided source documents and conversation history.

Brand context:
The documents come from four separate banking brands under the Westpac Group. You can identify them from the file paths:
- WBC = Westpac (the parent brand)
- SGB / STG = St.George Bank
- BSA = BankSA
- BOM = Bank of Melbourne
These are separate brands with separate products and terms. Differences between them are expected and normal — not contradictions. Always attribute information to the correct brand by name.

Rules:
- Answer the question using the information in the sources provided below.
- Cite your sources using [Source N] notation inline.
- When sources from different brands give different information, present each brand's position clearly rather than calling it a discrepancy.
- If previous conversation context is provided, use it to understand follow-up questions and maintain continuity.
- If the sources don't contain enough information to fully answer, say what you can and note what's missing.
- Be precise with financial terms, amounts, dates, and conditions.
- Keep your answer clear and well-structured.
- Do not make up information that isn't in the sources.`;

async function ragAnswer(query, results, memory = null, { stream = true } = {}) {
  const context = formatContext(results);

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

  // Build conversation context from memory
  let memoryContext = '';
  let historyMessages = [];
  let queryEmb = null;

  if (memory) {
    const queryResult = await rv.embed(query);
    queryEmb = new Float32Array(queryResult.embedding);
    const pastInteractions = await memory.findRelevant(queryEmb, 3);

    if (pastInteractions.length > 0) {
      if (stream) {
        console.log('\n  Relevant past interactions:');
        pastInteractions.forEach((m, i) => {
          console.log(`    [memory ${i + 1}] "${m.query}" (sim: ${m.similarity.toFixed(2)})`);
        });
      }

      memoryContext = '\n\nRelevant past interactions:\n' +
        pastInteractions.map((m, i) =>
          `[Past Q${i + 1}]: ${m.query}\n[Past A${i + 1}]: ${m.answer}`
        ).join('\n\n');
    }

    const recent = memory.getRecentHistory(6);
    if (recent.length > 0) {
      historyMessages = recent.map(h => ({
        role: h.role,
        content: h.content,
      }));
    }
  }

  if (stream) {
    console.log('\n  Answer:\n');
  }

  const messages = [
    { role: 'system', content: RAG_SYSTEM_PROMPT },
    ...historyMessages,
    { role: 'user', content: `Sources:\n\n${context}${memoryContext}\n\n---\n\nQuestion: ${query}` },
  ];

  const answer = await callLLM(messages, { stream });

  if (stream) {
    console.log('\n');
  }

  // Store interaction in memory
  if (memory && queryEmb) {
    await memory.store(query, answer, results, queryEmb);
  }

  // Build sources summary for non-streaming callers
  const sources = results.map((r, i) => ({
    index: i + 1,
    file: r.file,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    score: (r.combinedScore ?? r.score ?? r.vectorScore ?? 0),
  }));

  return { answer, sources };
}

module.exports = { RAG_SYSTEM_PROMPT, ragAnswer };
