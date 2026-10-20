'use strict';

// Provider documentation is linked in README.md. Keys only travel in HTTPS headers.
const AI_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' }),
  Object.freeze({ id: 'anthropic', label: 'Anthropic / Claude', defaultModel: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com/v1' }),
  Object.freeze({ id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
  Object.freeze({ id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/gpt-4.1-mini', baseUrl: 'https://openrouter.ai/api/v1' }),
  Object.freeze({ id: 'groq', label: 'Groq', defaultModel: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1' }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' })
]);

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 400000;

function providerFor(id) {
  const provider = AI_PROVIDERS.find(item => item.id === id);
  if (!provider) throw new Error('Choose a supported AI provider.');
  return provider;
}

async function readJson(response, label) {
  const size = Number(response.headers.get('content-length'));
  if (size > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} returned a response that is too large.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} returned an empty response.`);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${label} returned a response that is too large.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new Error(`${label} returned an invalid JSON response. Try again.`);
  }
}

function outputText(data, provider) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${provider.label} returned an invalid JSON response. Try again.`);
  }
  let text = '';
  if (provider.id === 'openai') {
    if (data.status === 'incomplete' || data.status === 'failed' || data.error) {
      throw new Error('OpenAI could not finish the proposal. Try a smaller request or another model.');
    }
    text = (Array.isArray(data.output) ? data.output : [])
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(item => item.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text).join('\n');
    if (!text && typeof data.output_text === 'string') text = data.output_text;
  } else if (provider.id === 'anthropic') {
    if (data.stop_reason === 'max_tokens') throw new Error('Claude reached its output limit. Try a smaller request.');
    text = (Array.isArray(data.content) ? data.content : [])
      .filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
  } else if (provider.id === 'gemini') {
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new Error('Gemini could not finish the proposal. Try a smaller request or another model.');
    }
    text = (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
      .filter(item => typeof item.text === 'string' && item.thought !== true).map(item => item.text).join('\n');
  } else {
    const choice = data.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop') {
      throw new Error(`${provider.label} could not finish the proposal. Try a smaller request or another model.`);
    }
    const content = choice?.message?.content;
    text = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
      .filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
  }
  if (!text.trim()) throw new Error(`${provider.label} returned no text proposal. Check model access or try another model.`);
  return text;
}

async function generateFixProposal({ provider: providerId, model, apiKey, baseUrl, systemInstruction, prompt } = {}) {
  const provider = providerFor(providerId);
  if (baseUrl && String(baseUrl).replace(/\/+$/, '') !== provider.baseUrl) {
    throw new Error('Custom AI endpoints are not supported. Choose a listed provider.');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim() || !/^[\x21-\x7e]{8,4096}$/.test(apiKey.trim())) {
    throw new Error(`Add a valid ${provider.label} API key in Connections.`);
  }
  const selectedModel = model || provider.defaultModel;
  if (typeof selectedModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(selectedModel)) {
    throw new Error('Enter a valid model ID from your AI provider.');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS ||
      typeof systemInstruction !== 'string' || systemInstruction.length > 20000) {
    throw new Error('The AI request is empty or too large. Select a smaller project or request.');
  }

  let endpoint;
  let body;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provider.id === 'openai') {
    endpoint = `${provider.baseUrl}/responses`;
    headers.Authorization = `Bearer ${apiKey.trim()}`;
    body = { model: selectedModel, instructions: systemInstruction, input: prompt, max_output_tokens: 12000, store: false };
  } else if (provider.id === 'anthropic') {
    endpoint = `${provider.baseUrl}/messages`;
    headers['x-api-key'] = apiKey.trim();
    headers['anthropic-version'] = '2023-06-01';
    body = { model: selectedModel, system: systemInstruction, messages: [{ role: 'user', content: prompt }], max_tokens: 12000 };
  } else if (provider.id === 'gemini') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(selectedModel)) throw new Error('Use a Gemini model ID without a URL or path.');
    endpoint = `${provider.baseUrl}/models/${encodeURIComponent(selectedModel)}:generateContent`;
    headers['x-goog-api-key'] = apiKey.trim();
    body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 12000, responseMimeType: 'application/json' }
    };
  } else {
    endpoint = `${provider.baseUrl}/chat/completions`;
    headers.Authorization = `Bearer ${apiKey.trim()}`;
    body = { model: selectedModel, messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: prompt }], max_tokens: 12000 };
    // Groq's reasoning models use the newer token-limit field.
    if (provider.id === 'groq') {
      delete body.max_tokens;
      body.max_completion_tokens = 12000;
    }
  }

  const signal = AbortSignal.timeout(90000);
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
  } catch {
    throw new Error(signal.aborted
      ? `${provider.label} timed out after 90 seconds. Try a smaller request.`
      : `Could not reach ${provider.label}. Check your internet connection and try again.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const detail = response.status === 401 || response.status === 403 ? 'Check your API key and model access.'
      : response.status === 429 ? 'Check your quota or billing, then try again later.'
      : 'Check the model ID and account access, then try again.';
    throw new Error(`${provider.label} request failed (HTTP ${response.status}). ${detail}`);
  }
  let data;
  try {
    data = await readJson(response, provider.label);
  } catch (error) {
    if (signal.aborted) throw new Error(`${provider.label} timed out after 90 seconds. Try a smaller request.`);
    // Only our own fixed validation messages are safe to display.
    if (/ returned (a response that is too large|an empty response|an invalid JSON response)/.test(error.message)) throw error;
    throw new Error(`${provider.label} response could not be read. Try again.`);
  }
  return outputText(data, provider);
}

module.exports = { AI_PROVIDERS, generateFixProposal };
