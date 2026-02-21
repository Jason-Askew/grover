const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = require('../config');

const DEBUG = process.env.GROVER_DEBUG === '1';
const LLM_TIMEOUT_MS = 60000;

function fetchLLM(messages, stream = true) {
  if (!LLM_API_KEY) {
    throw new Error('OPENAI_API_KEY not set. Export it: export OPENAI_API_KEY=sk-...');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  return fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream,
      temperature: 0.2,
      max_tokens: 2048,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

async function streamSSE(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content || '';
        if (token) {
          fullResponse += token;
          onToken(token);
        }
      } catch (e) {
        if (DEBUG) console.error('[debug] SSE parse error:', e.message);
      }
    }
  }

  return fullResponse;
}

async function callLLM(messages, { stream = true } = {}) {
  const response = await fetchLLM(messages, stream);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error (${response.status}): ${err.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  return streamSSE(response, token => process.stdout.write(token));
}

async function callLLMStream(messages, onToken) {
  const response = await fetchLLM(messages, true);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error (${response.status}): ${err.slice(0, 200)}`);
  }

  return streamSSE(response, onToken);
}

module.exports = { callLLM, callLLMStream };
