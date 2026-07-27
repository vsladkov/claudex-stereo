import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_REGISTRY,
  defaultPairEffort,
  modelProviderFor,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  parseQualifiedModel,
  registryEntryForModel,
} from '../plugins/stereo/src/models/registry.ts';

test('normalizeRequestedModel resolves the documented aliases to exact models', () => {
  assert.equal(normalizeRequestedModel('sol'), 'gpt-5.6-sol');
  assert.equal(normalizeRequestedModel('terra'), 'gpt-5.6-terra');
  assert.equal(normalizeRequestedModel('luna'), 'gpt-5.6-luna');
  assert.equal(normalizeRequestedModel('spark'), 'gpt-5.3-codex-spark');
  assert.equal(normalizeRequestedModel('kimi'), 'kimi-k3');
  assert.equal(normalizeRequestedModel('qwen'), 'qwen3.7-plus');
  assert.equal(normalizeRequestedModel('deepseek'), 'deepseek-v4-pro');
  assert.equal(normalizeRequestedModel('glm'), 'glm-5.1');
});

test('normalizeRequestedModel strips one optional codex: runtime prefix', () => {
  assert.equal(normalizeRequestedModel('codex:sol'), 'gpt-5.6-sol');
  assert.equal(normalizeRequestedModel('  CODEX:Glm  '), 'glm-5.1');
  assert.equal(normalizeRequestedModel('codex:gpt-5.6-sol@azure'), 'gpt-5.6-sol@azure');
  assert.equal(normalizeRequestedModel('codex:my-local-model'), 'my-local-model');
  // Exactly one strip, which keeps a literal codex:-prefixed id addressable.
  assert.equal(normalizeRequestedModel('codex:codex:latest'), 'codex:latest');
});

test('normalizeRequestedModel rejects empty and Claude selections under codex:', () => {
  assert.throws(
    () => normalizeRequestedModel('codex:'),
    new Error('Unsupported model "codex:". Use codex:<model> or a bare Codex model id.'),
  );
  assert.throws(
    () => normalizeRequestedModel('codex:   '),
    new Error('Unsupported model "codex:". Use codex:<model> or a bare Codex model id.'),
  );
  assert.throws(
    () => normalizeRequestedModel('codex:claude:opus'),
    new Error(
      'Unsupported model "codex:claude:opus". The codex: prefix addresses Codex runtime models; claude: selections are not Codex models.',
    ),
  );
  assert.throws(
    () => normalizeRequestedModel('CODEX:CLAUDE:session'),
    new Error(
      'Unsupported model "CODEX:CLAUDE:session". The codex: prefix addresses Codex runtime models; claude: selections are not Codex models.',
    ),
  );
});

test('normalizeRequestedModel matches aliases case-insensitively and trims whitespace', () => {
  assert.equal(normalizeRequestedModel('  SOL  '), 'gpt-5.6-sol');
  assert.equal(normalizeRequestedModel('Terra'), 'gpt-5.6-terra');
  assert.equal(normalizeRequestedModel('\tLuNa\n'), 'gpt-5.6-luna');
  assert.equal(normalizeRequestedModel(' Spark'), 'gpt-5.3-codex-spark');
  assert.equal(normalizeRequestedModel(' KiMi '), 'kimi-k3');
  assert.equal(normalizeRequestedModel('QWEN'), 'qwen3.7-plus');
});

test('normalizeRequestedModel passes unknown models through with original casing', () => {
  assert.equal(normalizeRequestedModel('gpt-5.5'), 'gpt-5.5');
  assert.equal(normalizeRequestedModel('GPT-5.6-Sol-Custom'), 'GPT-5.6-Sol-Custom');
  assert.equal(normalizeRequestedModel('  my-local-model  '), 'my-local-model');
});

test('normalizeRequestedModel resolves only the model side of qualified selections', () => {
  assert.equal(normalizeRequestedModel('kimi@custom'), 'kimi-k3@custom');
  assert.equal(normalizeRequestedModel(' SOL@azure '), 'gpt-5.6-sol@azure');
  assert.equal(normalizeRequestedModel('Unregistered-X@my-provider'), 'Unregistered-X@my-provider');
});

test('normalizeRequestedModel returns null for null and empty input', () => {
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel(undefined), null);
  assert.equal(normalizeRequestedModel(''), null);
  assert.equal(normalizeRequestedModel('   '), null);
});

test('defaultPairEffort defaults every gpt-* model to max and omits unknown non-OpenAI effort', () => {
  assert.equal(defaultPairEffort('gpt-5.6'), 'max');
  assert.equal(defaultPairEffort('gpt-5.6-sol'), 'max');
  assert.equal(defaultPairEffort('gpt-5.6-terra'), 'max');
  assert.equal(defaultPairEffort('gpt-5.5'), 'max');
  assert.equal(defaultPairEffort('gpt-5.3-codex-spark'), 'max');
  assert.equal(defaultPairEffort('gpt-5.60'), 'max');
  assert.equal(defaultPairEffort('some-chat-model'), null);
  assert.equal(defaultPairEffort('gpt-5.6-custom@azure'), 'max');
  assert.equal(defaultPairEffort('gpt-5.5@azure'), 'max');
  assert.equal(defaultPairEffort('some-chat-model@local'), null);
});

test('normalizeReasoningEffort accepts the seven valid efforts', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeReasoningEffort(effort), effort);
  }
  assert.equal(normalizeReasoningEffort('  MAX  '), 'max');
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort(undefined), null);
  assert.equal(normalizeReasoningEffort('   '), null);
});

test('normalizeReasoningEffort rejects unknown efforts with the exact error text', () => {
  assert.throws(
    () => normalizeReasoningEffort('garbage'),
    new Error(
      'Unsupported reasoning effort "garbage". Use one of: none, minimal, low, medium, high, xhigh, max.',
    ),
  );
  assert.throws(
    () => normalizeReasoningEffort(' ultra '),
    new Error(
      'Unsupported reasoning effort " ultra ". Use one of: none, minimal, low, medium, high, xhigh, max.',
    ),
  );
});

test('registry entries drive defaultPairEffort ahead of the gpt-* fallback rule', () => {
  // Every registry row's declared effort is what defaultPairEffort returns
  // for its resolved model - the row is authoritative, not the string rule.
  for (const entry of Object.values(MODEL_REGISTRY)) {
    assert.equal(defaultPairEffort(entry.model), entry.defaultPairEffort);
    assert.deepEqual(registryEntryForModel(entry.model), entry);
  }
  // Unregistered OpenAI models still use the gpt-* fallback.
  assert.equal(registryEntryForModel('gpt-5.6-nova'), null);
  assert.equal(defaultPairEffort('gpt-5.6-nova'), 'max');
  assert.deepEqual(registryEntryForModel('kimi-k3'), MODEL_REGISTRY.kimi);
  assert.equal(defaultPairEffort('kimi-k3'), null);
});

test('provider models omit pair effort and route exact registered model ids', () => {
  const expectedProviders = {
    'kimi-k3': 'moonshot',
    'qwen3.7-plus': 'dashscope',
    'deepseek-v4-pro': 'deepseek',
    'glm-5.1': 'zhipu',
  };

  for (const [model, provider] of Object.entries(expectedProviders)) {
    assert.equal(defaultPairEffort(model), null);
    assert.equal(modelProviderFor(model), provider);
  }

  assert.equal(modelProviderFor('some-chat-model'), null);
  assert.equal(modelProviderFor('kimi-k3-custom'), null);
});

test('parseQualifiedModel splits explicit providers and preserves unqualified ids', () => {
  assert.deepEqual(parseQualifiedModel('unregistered-x'), {
    model: 'unregistered-x',
    modelProvider: null,
  });
  assert.deepEqual(parseQualifiedModel('unregistered-x@myprov'), {
    model: 'unregistered-x',
    modelProvider: 'myprov',
  });

  const registrySelection = parseQualifiedModel('kimi-k3');
  assert.equal(
    registrySelection.modelProvider ?? modelProviderFor(registrySelection.model),
    'moonshot',
  );
  const overrideSelection = parseQualifiedModel('kimi-k3@custom');
  assert.equal(
    overrideSelection.modelProvider ?? modelProviderFor(overrideSelection.model),
    'custom',
  );
});

test('parseQualifiedModel rejects malformed qualified selections', () => {
  for (const model of ['@p', 'm@', 'm@a@b', 'm@a b']) {
    assert.throws(
      () => parseQualifiedModel(model),
      new Error(`Unsupported model "${model}". Use <model> or <model>@<provider>.`),
    );
  }
});
