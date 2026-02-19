const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = require('../config');

async function callLLM(messages, { stream = true } = {}) {
  if (!LLM_API_KEY) {
    throw new Error('OPENAI_API_KEY not set. Export it: export OPENAI_API_KEY=sk-...');
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
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
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error (${response.status}): ${err.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

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
          process.stdout.write(token);
          fullResponse += token;
        }
      } catch (e) {
        // skip malformed chunks
      }
    }
  }

  return fullResponse;
}

async function callLLMStream(messages, onToken) {
  if (!LLM_API_KEY) {
    throw new Error('OPENAI_API_KEY not set. Export it: export OPENAI_API_KEY=sk-...');
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream: true,
      temperature: 0.2,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error (${response.status}): ${err.slice(0, 200)}`);
  }

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
        // skip malformed chunks
      }
    }
  }

  return fullResponse;
}

module.exports = { callLLM, callLLMStream };
