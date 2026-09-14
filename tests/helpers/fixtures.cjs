function config(apiProvider = 'openai-compatible', overrides = {}) {
  return {
    apiProvider, url: 'https://example.invalid/chat/completions', apiKey: 'test-only',
    model: 'test-model', maxTokens: 256, timeout: 1000,
    thinkingEnabled: false, reasoningEffort: 'high',
    toolThinkingEnabled: false, toolReasoningEffort: 'high',
    extraBody: {}, ...overrides,
  };
}

const tool = {
  type: 'function',
  function: {
    name: 'lookup', description: 'Fixture only',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};
const toolCall = {
  id: 'call_fixture', type: 'function',
  function: { name: 'lookup', arguments: '{}' },
};
const messages = [{ role: 'user', content: 'hello' }];
const completion = (overrides = {}) => ({
  model: 'response-model',
  choices: [{ message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
  ...overrides,
});

module.exports = { config, tool, toolCall, messages, completion };
