import assert from 'node:assert/strict';
import test from 'node:test';

import {
  builtinCatalog,
  loadCodexCatalog,
  writeCodexCatalogCache,
} from '../plugins/stereo/src/models/catalog.ts';
import type { CodexCatalog } from '../plugins/stereo/src/models/catalog.ts';
import {
  MODEL_REGISTRY,
  defaultModelEffort,
  modelProviderFor,
  normalizeReasoningEffort,
  parseCodexSelection,
  parseQualifiedModel,
  registryEntryForModel,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import { parseFamilySelection } from '../plugins/stereo/src/models/model-table.ts';
import { accountCatalogModels, catalogEntry, catalogFixture } from './helpers.ts';

// The test process has its own CODEX_HOME (env-bootstrap), so seeding it the
// way a launch-ready check does gives every default resolution below the
// same catalog the fake Codex serves.
writeCodexCatalogCache(accountCatalogModels(), { fetchedAt: '2026-09-24T00:00:00.000Z' });

// The two-step selection API, as the commands use it: parse before the
// runtime probe, resolve against the loaded catalog after it.
function resolveRequested(
  model: unknown,
  options: { catalog?: ReturnType<typeof loadCodexCatalog> } = {},
): string | null {
  const selection = parseCodexSelection(model);
  return selection ? resolveCodexSelection(selection, options.catalog ?? loadCodexCatalog()) : null;
}

test('normalizeRequestedModel strips one optional codex: runtime prefix', () => {
  assert.equal(resolveRequested('codex:astra'), 'gpt-6-astra');
  assert.equal(resolveRequested('codex:sol'), 'gpt-6-sol');
  assert.equal(resolveRequested('  CODEX:Glm  '), 'glm-5.2');
  assert.equal(resolveRequested('codex:gpt-5.6-sol@azure'), 'gpt-5.6-sol@azure');
  assert.equal(resolveRequested('codex:my-local-model'), 'my-local-model');
  // Exactly one strip, which keeps a literal codex:-prefixed id addressable.
  assert.equal(resolveRequested('codex:codex:latest'), 'codex:latest');
});

test('normalizeRequestedModel rejects empty and Claude selections under codex:', () => {
  assert.throws(
    () => resolveRequested('codex:'),
    new Error('Unsupported model "codex:". Use codex:<model> or a bare Codex model id.'),
  );
  assert.throws(
    () => resolveRequested('codex:   '),
    new Error('Unsupported model "codex:". Use codex:<model> or a bare Codex model id.'),
  );
  assert.throws(
    () => resolveRequested('codex:claude:opus'),
    new Error(
      'Unsupported model "codex:claude:opus". The codex: prefix addresses Codex runtime models; claude: selections are not Codex models.',
    ),
  );
  assert.throws(
    () => resolveRequested('CODEX:CLAUDE:session'),
    new Error(
      'Unsupported model "CODEX:CLAUDE:session". The codex: prefix addresses Codex runtime models; claude: selections are not Codex models.',
    ),
  );
});

test('parseCodexSelection needs no catalog and resolveCodexSelection needs no re-parse', () => {
  assert.equal(parseCodexSelection(null), null);
  assert.equal(parseCodexSelection('   '), null);
  assert.deepEqual(parseCodexSelection(' Codex:Sol-5.6@Azure '), {
    normalized: 'Codex:Sol-5.6@Azure',
    key: 'sol-5.6',
    bareModel: 'Sol-5.6',
    modelProvider: 'Azure',
  });
  assert.throws(() => parseCodexSelection('m@a@b'), /Use <model> or <model>@<provider>/);
  const older = catalogFixture([catalogEntry('gpt-5.6-sol')]);
  assert.equal(resolveCodexSelection(parseCodexSelection('sol')!, older), 'gpt-5.6-sol');
  assert.equal(
    resolveCodexSelection(parseCodexSelection('Sol-5.6@azure')!, older),
    'gpt-5.6-sol@azure',
  );
});

test('normalizeRequestedModel matches aliases case-insensitively and trims whitespace', () => {
  assert.equal(resolveRequested('  SOL  '), 'gpt-6-sol');
  assert.equal(resolveRequested('Terra'), 'gpt-5.6-terra');
  assert.equal(resolveRequested('\tLuNa\n'), 'gpt-6-luna');
  assert.equal(resolveRequested(' KiMi '), 'kimi-k3');
  assert.equal(resolveRequested('QWEN'), 'qwen3.7-plus');
});

test('normalizeRequestedModel passes unknown models through with original casing', () => {
  assert.equal(resolveRequested('gpt-5.5'), 'gpt-5.5');
  assert.equal(resolveRequested('GPT-5.6-Sol-Custom'), 'GPT-5.6-Sol-Custom');
  assert.equal(resolveRequested('  my-local-model  '), 'my-local-model');
});

test('a family or alias selection resolves only the model side of qualified selections', () => {
  assert.equal(resolveRequested('kimi@custom'), 'kimi-k3@custom');
  assert.equal(resolveRequested(' SOL@azure '), 'gpt-6-sol@azure');
  assert.equal(resolveRequested('Unregistered-X@my-provider'), 'Unregistered-X@my-provider');
  assert.equal(resolveRequested('claude-sonnet-4@anthropic'), 'claude-sonnet-4@anthropic');
});

test('a null or empty selection resolves to null for null and empty input', () => {
  assert.equal(resolveRequested(null), null);
  assert.equal(resolveRequested(undefined), null);
  assert.equal(resolveRequested(''), null);
  assert.equal(resolveRequested('   '), null);
});

test('normalizeReasoningEffort accepts the valid efforts', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
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
      'Unsupported reasoning effort "garbage". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.',
    ),
  );
  assert.throws(
    () => normalizeReasoningEffort(' hyper '),
    new Error(
      'Unsupported reasoning effort " hyper ". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.',
    ),
  );
});

test('registry entries drive defaultModelEffort ahead of the gpt-* fallback rule', () => {
  for (const entry of Object.values(MODEL_REGISTRY)) {
    // A row that names no effort takes none.
    assert.equal(defaultModelEffort(entry.model), null);
    assert.deepEqual(registryEntryForModel(entry.model), entry);
  }
  assert.equal(registryEntryForModel('gpt-5.6-nova'), null);
  assert.equal(defaultModelEffort('gpt-5.6-nova'), 'xhigh');
  assert.deepEqual(registryEntryForModel('kimi-k3'), MODEL_REGISTRY.kimi);
  assert.equal(defaultModelEffort('kimi-k3'), null);
});

test('provider models omit a default effort and route exact registered model ids', () => {
  const expectedProviders = {
    'kimi-k3': 'moonshot',
    'qwen3.7-plus': 'dashscope',
    'deepseek-v4-pro': 'deepseek',
    'glm-5.2': 'zhipu',
  };

  for (const [model, provider] of Object.entries(expectedProviders)) {
    assert.equal(defaultModelEffort(model), null);
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

test('family selections resolve to the latest version in the catalog, aliases to their ids, and version pins hold', () => {
  assert.equal(resolveRequested('astra'), 'gpt-6-astra');
  assert.equal(resolveRequested('sol'), 'gpt-6-sol');
  assert.equal(resolveRequested('terra'), 'gpt-5.6-terra');
  assert.equal(resolveRequested('luna'), 'gpt-6-luna');
  assert.equal(resolveRequested('kimi'), 'kimi-k3');
  assert.equal(resolveRequested('qwen'), 'qwen3.7-plus');
  assert.equal(resolveRequested('deepseek'), 'deepseek-v4-pro');
  assert.equal(resolveRequested('glm'), 'glm-5.2');
  assert.equal(resolveRequested('sol-5.6'), 'gpt-5.6-sol');
  assert.equal(resolveRequested('codex:sol-6'), 'gpt-6-sol');
  assert.equal(resolveRequested('astra-6'), 'gpt-6-astra');
  assert.equal(resolveRequested('Luna-5.6@azure'), 'gpt-5.6-luna@azure');
  // A catalog that still only lists the 5.6 generation changes what "latest" means.
  const older = catalogFixture([catalogEntry('gpt-5.6-sol'), catalogEntry('gpt-5.6-terra')]);
  assert.equal(resolveRequested('sol', { catalog: older }), 'gpt-5.6-sol');
  assert.equal(resolveRequested('codex:terra', { catalog: older }), 'gpt-5.6-terra');
  // The family grammar itself, minus the family-less gpt-<version> ids.
  assert.deepEqual(parseFamilySelection('sol-5.6'), { family: 'sol', version: '5.6' });
  assert.deepEqual(parseFamilySelection('nova'), { family: 'nova', version: null });
  assert.equal(parseFamilySelection('gpt-5.5'), null);
  assert.equal(parseFamilySelection('kimi-k3'), null);
  // Three-segment versions resolve like any other.
  const patched = catalogFixture([catalogEntry('gpt-5.6.1-sol'), catalogEntry('gpt-5.6-sol')]);
  assert.equal(resolveRequested('sol', { catalog: patched }), 'gpt-5.6.1-sol');
  assert.equal(resolveRequested('sol-5.6.1', { catalog: patched }), 'gpt-5.6.1-sol');
});

test('a family word the catalog cannot resolve is refused, naming what it lists', () => {
  assert.throws(
    () => resolveRequested('codex:sol-4'),
    new Error(
      'Cannot resolve "codex:sol-4": the Codex model catalog lists sol versions 6 (gpt-6-sol), 5.6 (gpt-5.6-sol). Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider\'s model.',
    ),
  );
  // A family word the live catalog does not list would fail inside Codex
  // after the job record exists; it is refused here with the family list.
  for (const selection of ['nova', 'nova-6', 'codex:atsra', 'mini']) {
    assert.throws(
      () => resolveRequested(selection),
      /lists no (nova|atsra|mini) family, only codex:astra, codex:luna, codex:sol, codex:terra\. .*<id>@<provider>/,
    );
  }
  // A provider-qualified id is not an OpenAI model, so the catalog cannot
  // vouch for or against its family word: it passes through raw.
  assert.equal(resolveRequested('llama3@ollama'), 'llama3@ollama');
  assert.equal(resolveRequested('codex:nova-6@azure'), 'nova-6@azure');
  assert.equal(resolveRequested('sol@azure'), 'gpt-6-sol@azure');
  // Raw ids the family grammar does not claim, and ids the catalog lists
  // itself, still pass through.
  assert.equal(resolveRequested('gpt-6-sol'), 'gpt-6-sol');
  assert.equal(resolveRequested('gpt-reserve'), 'gpt-reserve');
  assert.equal(resolveRequested('gpt-5.5'), 'gpt-5.5');
  // A word with a digit the catalog does not list is a custom provider's raw
  // id, before or after any fetch; only a purely alphabetic word is a typo.
  for (const catalog of [loadCodexCatalog(), builtinCatalog()]) {
    assert.equal(resolveRequested('codex:llama3', { catalog }), 'llama3');
    assert.equal(resolveRequested('qwen3', { catalog }), 'qwen3');
    assert.equal(resolveRequested('codex:mistral:7b', { catalog }), 'mistral:7b');
  }
  // A family the catalog grows into resolves without a code change.
  const grown = catalogFixture([catalogEntry('gpt-6-nova'), catalogEntry('gpt-6-astra')]);
  assert.equal(resolveRequested('nova', { catalog: grown }), 'gpt-6-nova');
});

test('before any fetch only the snapshot resolves, and a refusal names the failed fetch', () => {
  const floor: CodexCatalog = { ...builtinCatalog(), fetchFailure: 'connection refused' };
  assert.throws(
    () => resolveRequested('codex:sol', { catalog: floor }),
    new Error(
      'Cannot resolve "codex:sol": fetching the Codex model catalog failed (connection refused), and the built-in snapshot lists no sol family, only codex:astra. Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider\'s model.',
    ),
  );
  for (const selection of ['sol-5.6', 'astra-7']) {
    assert.throws(
      () => resolveRequested(selection, { catalog: builtinCatalog() }),
      /no Codex model catalog has been fetched yet \(\/stereo:setup fetches it\), and the built-in snapshot lists/,
      selection,
    );
  }
  // What the snapshot or the registry resolves, full ids, and provider-qualified ids pass.
  assert.equal(resolveRequested('astra', { catalog: floor }), 'gpt-6-astra');
  assert.equal(resolveRequested('codex:astra-6', { catalog: floor }), 'gpt-6-astra');
  assert.equal(resolveRequested('kimi', { catalog: floor }), 'kimi-k3');
  assert.equal(resolveRequested('gpt-5.6-sol', { catalog: floor }), 'gpt-5.6-sol');
  assert.equal(resolveRequested('sol@azure', { catalog: floor }), 'sol@azure');
});

test('defaultModelEffort takes the catalog tier for gpt-* ids, provider suffix or not, and none for other ids', () => {
  // How the tier steps down is defaultCatalogEffort's (codex-catalog.test.ts).
  const catalog = catalogFixture([
    catalogEntry('gpt-6-astra'),
    catalogEntry('gpt-5-astra', { efforts: ['low', 'medium', 'high'] }),
  ]);
  assert.equal(defaultModelEffort('gpt-6-astra', { catalog }), 'xhigh');
  assert.equal(defaultModelEffort('gpt-5-astra', { catalog }), 'high');
  assert.equal(defaultModelEffort('gpt-5-astra@azure', { catalog }), 'high');
  assert.equal(defaultModelEffort('gpt-8-unknown', { catalog }), 'xhigh');
  assert.equal(defaultModelEffort('some-chat-model', { catalog }), null);
  assert.equal(defaultModelEffort('some-chat-model@local', { catalog }), null);
  // Registry rows decide for third-party models, whatever the catalog lists.
  assert.equal(defaultModelEffort('kimi-k3', { catalog }), null);
});

test('a registry model id resolves as itself before the family grammar can claim it', () => {
  // `glm-5.2` is family-shaped; a `codex:glm` job records it, and a resume
  // passes it back, so it must never read as "family glm, version 5.2".
  for (const catalog of [loadCodexCatalog(), catalogFixture(accountCatalogModels())]) {
    for (const selection of ['glm-5.2', 'codex:glm-5.2', 'GLM-5.2', 'codex:GLM-5.2']) {
      assert.equal(resolveRequested(selection, { catalog }), 'glm-5.2', selection);
    }
    assert.equal(resolveRequested('glm-5.2@zhipu', { catalog }), 'glm-5.2@zhipu');
    assert.equal(resolveRequested('KIMI-K3', { catalog }), 'kimi-k3');
  }
  // The provider row is found in any case too.
  assert.equal(modelProviderFor('GLM-5.2'), 'zhipu');
  assert.equal(registryEntryForModel('Kimi-K3')?.modelProvider, 'moonshot');
});

test('a Codex version pin takes dashes between its segments, like the Claude grammar', () => {
  assert.deepEqual(parseFamilySelection('astra-6-1'), { family: 'astra', version: '6.1' });
  assert.deepEqual(parseFamilySelection('sol-5-6-1'), { family: 'sol', version: '5.6.1' });
  const catalog = catalogFixture([
    catalogEntry('gpt-6.1-astra'),
    catalogEntry('gpt-6-astra'),
    catalogEntry('gpt-5.6-sol'),
  ]);
  assert.equal(resolveRequested('codex:astra-6-1', { catalog }), 'gpt-6.1-astra');
  assert.equal(resolveRequested('astra-6.1', { catalog }), 'gpt-6.1-astra');
  assert.equal(resolveRequested('codex:sol-5-6', { catalog }), 'gpt-5.6-sol');
  assert.throws(
    () => resolveRequested('codex:astra-6-2', { catalog }),
    /^Error: Cannot resolve "codex:astra-6-2": the Codex model catalog lists astra versions/,
  );
  // Third-party ids with a non-numeric segment keep falling through raw.
  assert.equal(parseFamilySelection('kimi-k3'), null);
  assert.equal(parseFamilySelection('deepseek-v4-pro'), null);
});
