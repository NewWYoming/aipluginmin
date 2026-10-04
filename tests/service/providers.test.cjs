const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLoader } = require('../helpers/load-typescript.cjs');
const { config, tool, toolCall, messages, completion } = require('../helpers/fixtures.cjs');
const { getProvider } = createLoader()('src/service/providers/index.ts');

for (const name of ['openai-compatible', 'deepseek-v4']) {
  const provider = getProvider(name);

  test(`${name}: retains custom fields, model overrides, sampling and tool wiring`, () => {
    const body = provider.buildRequestBody(config(name, {
      temperature: 0, topP: 0.8,
      extraBody: { model: 'custom-model', max_tokens: 99, seed: 7, temperature: 0.9 },
    }), messages, [tool], null);
    assert.equal(body.model, 'custom-model');
    assert.equal(body.max_tokens, 99);
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.seed, 7);
    assert.deepEqual(body.tools, [tool]);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.messages, messages);
  });

  test(`${name}: extraBody cannot enable streaming`, () => {
    const body = provider.buildRequestBody(config(name, {
      extraBody: { stream: true },
    }), messages, null, null);
    assert.equal(body.stream, false);
  });

  test(`${name}: extraBody cannot replace the conversation`, () => {
    const body = provider.buildRequestBody(config(name, {
      extraBody: { messages: [{ role: 'system', content: 'stale context' }] },
    }), messages, null, null);
    assert.deepEqual(body.messages, messages);
  });

  test(`${name}: no tools means extraBody cannot reinstall tools or force calls`, () => {
    for (const tools of [null, []]) {
      const body = provider.buildRequestBody(config(name, {
        extraBody: { tools: [tool], tool_choice: 'required' },
      }), messages, tools, 'none');
      assert.equal(Object.hasOwn(body, 'tools'), false);
      assert.equal(Object.hasOwn(body, 'tool_choice'), false);
    }
  });

  test(`${name}: explicit none remains authoritative when tools are present`, () => {
    const body = provider.buildRequestBody(config(name, {
      extraBody: { tools: [{ invalid: true }], tool_choice: 'required' },
    }), messages, [tool], 'none');
    assert.deepEqual(body.tools, [tool]);
    assert.equal(body.tool_choice, 'none');
  });

  test(`${name}: missing or sparse usage is normalized while cache details survive`, () => {
    assert.deepEqual(provider.parseResponse(completion()).usage, {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    });
    const usage = provider.parseResponse(completion({ usage: {
      prompt_tokens: 3, completion_tokens: 2, prompt_cache_hit_tokens: 1,
      prompt_tokens_details: { cached_tokens: 1 },
    } })).usage;
    assert.deepEqual(usage, {
      prompt_tokens: 3, completion_tokens: 2, total_tokens: 5,
      prompt_cache_hit_tokens: 1, prompt_tokens_details: { cached_tokens: 1 },
    });
  });

  test(`${name}: invalid token counters do not poison usage accounting`, () => {
    const usage = provider.parseResponse(completion({ usage: {
      prompt_tokens: -1, completion_tokens: '2', total_tokens: NaN,
    } })).usage;
    assert.deepEqual(usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    assert.deepEqual(provider.parseResponse(completion({ usage: 'invalid' })).usage, {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    });
  });

  test(`${name}: malformed envelopes are rejected at the protocol boundary`, () => {
    for (const raw of [null, {}, { choices: [] }, { choices: {} },
      { choices: [null] }, { choices: [{}] }, { choices: [{ message: [] }] },
      { choices: [{ message: { content: 12 } }] },
      { choices: [{ message: { content: '', tool_calls: {} } }] }]) {
      assert.throws(() => provider.parseResponse(raw), /Chat Completions/);
    }
  });

  test(`${name}: tool-only assistant messages accept null content and optional index`, () => {
    const result = provider.parseResponse(completion({ choices: [{
      message: { content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls',
    }] }));
    assert.equal(result.content, '');
    assert.deepEqual(result.tool_calls, [toolCall]);
    assert.equal(result.finish_reason, 'tool_calls');
  });

  test(`${name}: message serialization preserves tool IDs without mutating inputs`, () => {
    const history = [
      { role: 'assistant', content: '', tool_calls: [toolCall], reasoning_content: 'history' },
      { role: 'tool', content: 'result', tool_call_id: toolCall.id },
    ];
    const cfg = config(name, { thinkingEnabled: true, extraBody: { stream: true, temperature: 1 } });
    const before = JSON.stringify({ history, cfg });
    const body = provider.buildRequestBody(cfg, history, [tool], 'auto');
    assert.equal(body.messages[1].tool_call_id, toolCall.id);
    assert.deepEqual(body.messages[0].tool_calls, [toolCall]);
    assert.equal(JSON.stringify({ history, cfg }), before);
    assert.notEqual(body.messages, history);
    assert.notEqual(body.messages[0], history[0]);
  });
}

test('registry: preserves names, defaults, capabilities and unknown-provider errors', () => {
  const generic = getProvider('openai-compatible');
  assert.equal(generic.name, 'openai-compatible');
  assert.equal(generic.defaultModel, '');
  assert.equal(generic.defaultUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(generic.supportsThinking, false);
  assert.equal(generic.supportsReasoningEffort, false);
  const deepseek = getProvider('deepseek-v4');
  assert.equal(deepseek.name, 'deepseek-v4');
  assert.equal(deepseek.defaultModel, 'deepseek-v4-pro');
  assert.equal(deepseek.defaultUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(deepseek.supportsThinking, true);
  assert.equal(deepseek.supportsReasoningEffort, true);
  assert.throws(() => getProvider('unknown'), /未知 Provider/);
});

test('DeepSeek: thinking override, empty assistant reasoning and default model survive', () => {
  const history = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'previous answer' },
    { role: 'assistant', content: '', reasoning_content: 'prior reasoning', tool_calls: [toolCall] },
  ];
  const body = getProvider('deepseek-v4').buildRequestBody(config('deepseek-v4', {
    model: '', temperature: 1, topP: 0.9,
  }), history, [tool], 'auto', { enabled: true, effort: 'max' });
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max');
  assert.equal(Object.hasOwn(body.messages[0], 'reasoning_content'), false);
  assert.equal(body.messages[1].reasoning_content, '');
  assert.equal(body.messages[2].reasoning_content, 'prior reasoning');
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.equal(Object.hasOwn(body, 'top_p'), false);
});

test('DeepSeek: extraBody sampling cannot leak into thinking requests', () => {
  const body = getProvider('deepseek-v4').buildRequestBody(config('deepseek-v4', {
    thinkingEnabled: true, extraBody: { temperature: 0.5, top_p: 0.9 },
  }), messages, null, null);
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.equal(Object.hasOwn(body, 'top_p'), false);
});

test('DeepSeek: disabling thinking restores sampling and keeps prior reasoning', () => {
  const body = getProvider('deepseek-v4').buildRequestBody(config('deepseek-v4', {
    thinkingEnabled: true, temperature: 0.2, topP: 0.7,
  }), [{ role: 'assistant', content: '', reasoning_content: 'keep' }], null, null,
  { enabled: false, effort: 'low' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.7);
  assert.equal(body.messages[0].reasoning_content, 'keep');
});

test('reasoning response/request handling remains preset-specific', () => {
  const raw = completion({ choices: [{ message: { content: 'answer', reasoning_content: 'reasoning' } }] });
  assert.equal(getProvider('deepseek-v4').parseResponse(raw).reasoning_content, 'reasoning');
  const generic = getProvider('openai-compatible');
  assert.equal(generic.parseResponse(raw).reasoning_content, undefined);
  const body = generic.buildRequestBody(config(), [
    { role: 'assistant', content: 'answer', reasoning_content: 'reasoning' },
  ], null, null, { enabled: true, effort: 'max' });
  assert.equal(Object.hasOwn(body.messages[0], 'reasoning_content'), false);
  assert.equal(Object.hasOwn(body, 'thinking'), false);
});
