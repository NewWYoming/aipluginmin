const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLoader } = require('../helpers/load-typescript.cjs');
const { config, messages, completion } = require('../helpers/fixtures.cjs');

function setup(raw, { status = 200, text, parseResponse } = {}) {
  const usage = [], errors = [], requests = [];
  const load = createLoader({
    'src/AI/AI.ts': { AIManager: { updateUsage: (...args) => usage.push(args) } },
    'src/logger.ts': { logger: { info() {}, error: (...args) => errors.push(args) } },
    // Timing/host behavior is out of scope; this test targets the provider/HTTP seam.
    'src/utils/utils.ts': { withTimeout: operation => operation() },
  }, {
    fetch: async (...args) => {
      requests.push(args);
      return { ok: status >= 200 && status < 300, status,
        text: async () => text === undefined ? JSON.stringify(raw) : text };
    },
  });
  if (parseResponse) load('src/service/providers/index.ts').getProvider('openai-compatible').parseResponse = parseResponse;
  const { AIClient } = load('src/service/AIClient.ts');
  return { client: new AIClient(config()), usage, errors, requests };
}

test('HTTP client accounts normalized model/usage, not a raw choices envelope', async () => {
  const normalized = { content: 'adapted reply', tool_calls: [], finish_reason: 'stop',
    model: 'normalized-model', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
  const app = setup({ output: 'fixture', model: 'raw-model', usage: {} }, {
    parseResponse: () => normalized,
  });
  assert.deepEqual(await app.client.chat(messages, null, null), normalized);
  assert.deepEqual(app.usage, [['normalized-model', normalized.usage]]);
});

test('parse failure never records token usage', async () => {
  const app = setup(completion({ usage: { total_tokens: 123 } }), {
    parseResponse: () => { throw new Error('invalid provider payload'); },
  });
  const response = await app.client.chat(messages, null, null);
  assert.equal(response.finish_reason, 'error');
  assert.deepEqual(app.usage, []);
  assert.equal(app.errors.length, 1);
});

test('missing usage becomes zero usage before accounting', async () => {
  const app = setup(completion());
  const response = await app.client.chat(messages, null, null);
  assert.equal(response.content, 'hello back');
  assert.deepEqual(app.usage, [['response-model', {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  }]]);
  assert.equal(app.requests[0][1].method, 'POST');
  assert.equal(app.requests[0][1].headers.Authorization, 'Bearer test-only');
});

for (const [label, raw, options] of [
  ['HTTP error', { error: { message: 'unavailable' } }, { status: 503 }],
  ['API error', { error: { message: 'invalid request' } }, {}],
  ['empty body', null, { text: '' }],
  ['invalid JSON', null, { text: '<html>error</html>' }],
  ['invalid protocol envelope', { choices: [{}] }, {}],
]) {
  test(`${label} retains the error result without accounting`, async () => {
    const app = setup(raw, options);
    const response = await app.client.chat(messages, null, null);
    assert.equal(response.finish_reason, 'error');
    assert.equal(response.content, '');
    assert.deepEqual(response.tool_calls, []);
    assert.deepEqual(app.usage, []);
  });
}
