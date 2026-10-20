'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AI_PROVIDERS, generateFixProposal } = require('../lib/ai');

const options = { provider: 'openai', apiKey: 'test-private-key', systemInstruction: 'Return JSON.', prompt: 'Fix this code.' };
const proposal = '{"summary":"Fixed","patches":[]}';
const fixtures = {
  openai: { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: proposal }] }] },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: proposal }] },
  gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'reasoning' }, { text: proposal }] } }] },
  openrouter: { choices: [{ finish_reason: 'stop', message: { content: proposal } }] },
  groq: { choices: [{ finish_reason: 'stop', message: { content: proposal } }] },
  deepseek: { choices: [{ finish_reason: 'stop', message: { content: proposal } }] }
};

for (const provider of AI_PROVIDERS) {
  test(`${provider.id} sends its native request and extracts proposal text`, async t => {
    let captured;
    t.mock.method(globalThis, 'fetch', async (url, request) => {
      captured = { url, request, body: JSON.parse(request.body) };
      return Response.json(fixtures[provider.id]);
    });
    assert.equal(await generateFixProposal({ ...options, provider: provider.id }), proposal);
    assert.ok(captured.url.startsWith(`${provider.baseUrl}/`));
    assert.ok(!captured.url.includes(options.apiKey));
    assert.ok(!captured.request.body.includes(options.apiKey));
    assert.equal(captured.request.redirect, 'error');
    assert.ok(captured.request.signal instanceof AbortSignal);
    if (provider.id === 'gemini') assert.ok(captured.url.includes(`/models/${provider.defaultModel}:generateContent`));
    else assert.equal(captured.body.model, provider.defaultModel);
    if (provider.id === 'gemini') assert.equal(captured.request.headers['x-goog-api-key'], options.apiKey);
    else if (provider.id === 'anthropic') assert.equal(captured.request.headers['x-api-key'], options.apiKey);
    else assert.equal(captured.request.headers.Authorization, `Bearer ${options.apiKey}`);
    if (provider.id === 'openai') assert.equal(captured.body.store, false);
  });
}

test('rejects unlisted providers, endpoints, invalid model paths, and malformed keys before fetch', async t => {
  let called = false;
  t.mock.method(globalThis, 'fetch', async () => { called = true; throw new Error('unexpected request'); });
  await assert.rejects(generateFixProposal({ ...options, provider: 'custom' }), /supported AI provider/);
  await assert.rejects(generateFixProposal({ ...options, baseUrl: 'https://127.0.0.1/private' }), /Custom AI endpoints/);
  await assert.rejects(generateFixProposal({ ...options, baseUrl: 'https://api.openai.com.evil.test/v1' }), /Custom AI endpoints/);
  await assert.rejects(generateFixProposal({ ...options, provider: 'gemini', model: '../secrets' }), /valid model ID/);
  await assert.rejects(generateFixProposal({ ...options, provider: 'gemini', model: 'models/gemini-test' }), /without a URL or path/);
  await assert.rejects(generateFixProposal({ ...options, apiKey: 'private\r\nheader:bad' }), /valid OpenAI API key/);
  assert.equal(called, false);
});

test('provider and network failures never disclose provider responses or keys', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: `secret: ${options.apiKey}` } }, { status: 401 }));
  await assert.rejects(generateFixProposal(options), error => /HTTP 401/.test(error.message) && !error.message.includes(options.apiKey));
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error(`socket issue ${options.apiKey}`); });
  await assert.rejects(generateFixProposal(options), error => /Could not reach/.test(error.message) && !error.message.includes(options.apiKey));
});

test('rejects malformed, oversized, empty, and truncated responses', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not json'));
  await assert.rejects(generateFixProposal(options), /invalid JSON/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json(null));
  await assert.rejects(generateFixProposal(options), /invalid JSON/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ output: [] }));
  await assert.rejects(generateFixProposal(options), /no text proposal/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ status: 'incomplete', output: fixtures.openai.output }));
  await assert.rejects(generateFixProposal(options), /could not finish/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({}, { headers: { 'content-length': String(3 * 1024 * 1024) } }));
  await assert.rejects(generateFixProposal(options), /too large/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ stop_reason: 'max_tokens', content: fixtures.anthropic.content }));
  await assert.rejects(generateFixProposal({ ...options, provider: 'anthropic' }), /output limit/);
});

test('rejects missing and oversized prompts without contacting a provider', async t => {
  let called = false;
  t.mock.method(globalThis, 'fetch', async () => { called = true; return Response.json(fixtures.openai); });
  await assert.rejects(generateFixProposal({ ...options, prompt: '' }), /empty or too large/);
  await assert.rejects(generateFixProposal({ ...options, prompt: 'x'.repeat(400001) }), /empty or too large/);
  assert.equal(called, false);
});
