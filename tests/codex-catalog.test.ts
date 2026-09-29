import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertCodexEffortListed,
  builtinCatalog,
  catalogFamilyVersions,
  defaultCatalogEffort,
  describeCodexCatalogSource,
  fromLiveModel,
  isCodexCatalogFresh,
  listCodexCatalogFamilies,
  loadCodexCatalog,
  parseOpenAiModelId,
  recordCatalogFetchFailure,
  resolveCompanionCatalogFile,
  writeCodexCatalogCache,
} from '../plugins/stereo/src/models/catalog.ts';
import {
  defaultModelEffort,
  parseCodexSelection,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import type { Model } from '../plugins/stereo/src/protocol/app-server.ts';
import {
  accountCatalogModels,
  catalogEntry,
  catalogFixture,
  liveModel,
  makeTempDir,
} from './helpers.ts';

const catalog = catalogFixture(accountCatalogModels());

function writeCompanionCache(codexHome: string, payload: unknown): void {
  const file = resolveCompanionCatalogFile(codexHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}

test('parseOpenAiModelId splits gpt-<version>-<family> ids and rejects everything else', () => {
  assert.deepEqual(parseOpenAiModelId('gpt-6-astra'), { version: '6', family: 'astra' });
  assert.deepEqual(parseOpenAiModelId('gpt-5.6-sol'), { version: '5.6', family: 'sol' });
  assert.deepEqual(parseOpenAiModelId('gpt-5.6.1-sol'), { version: '5.6.1', family: 'sol' });
  assert.equal(parseOpenAiModelId('gpt-5.5'), null);
  assert.equal(parseOpenAiModelId('gpt-reserve'), null);
  assert.equal(parseOpenAiModelId('kimi-k3'), null);
  assert.equal(parseOpenAiModelId('gpt-6-astra-pro'), null);
});

test('an empty CODEX_HOME loads the one-model built-in floor and memoizes per home', () => {
  const home = makeTempDir();
  const first = loadCodexCatalog({ codexHome: home });
  assert.equal(first.source, 'builtin');
  assert.equal(first.path, null);
  assert.equal(first.fetchedAt, null);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(
    first.models.map((model) => model.id),
    ['gpt-6-astra'],
    'the floor holds exactly the built-in default',
  );
  assert.equal(loadCodexCatalog({ codexHome: home }), first, 'memoized per CODEX_HOME');

  writeCompanionCache(home, {
    version: 1,
    fetchedAt: '2026-09-24T08:00:00Z',
    models: [{ id: 'gpt-6-sol' }],
  });
  assert.equal(loadCodexCatalog({ codexHome: home }).source, 'builtin', 'memo holds');
});

test('the companion cache is read back with families re-derived from ids', () => {
  const home = makeTempDir();
  writeCompanionCache(home, {
    version: 1,
    fetchedAt: '2026-09-24T08:41:12.205Z',
    models: [
      { id: 'gpt-6-sol', family: 'wrong', version: '9', efforts: ['max', 'low', 'bogus'] },
      { id: 'gpt-reserve', efforts: [] },
      { nope: true },
    ],
  });
  const catalog = loadCodexCatalog({ codexHome: home });
  assert.equal(catalog.source, 'companion');
  assert.equal(catalog.path, resolveCompanionCatalogFile(home));
  assert.equal(catalog.fetchedAt, '2026-09-24T08:41:12.205Z');
  assert.deepEqual(catalog.models, [
    { id: 'gpt-6-sol', family: 'sol', version: '6', efforts: ['low', 'max'] },
    { id: 'gpt-reserve', family: null, version: null, efforts: [] },
  ]);
});

test('an unusable cache file falls through to the floor and is named as the one problem', () => {
  const fetchedAt = '2026-09-24T08:00:00Z';
  for (const payload of [
    '{broken',
    '[1, 2]',
    { version: 2, fetchedAt, models: [{ id: 'x' }] },
    { version: 1, fetchedAt },
    { version: 1, fetchedAt, models: [] },
    { version: 1, fetchedAt, models: [{ nope: true }] },
  ]) {
    // The catalog is memoized per CODEX_HOME, so each file gets a home of its own.
    const home = makeTempDir();
    writeCompanionCache(home, payload);
    const loaded = loadCodexCatalog({ codexHome: home });
    assert.equal(loaded.source, 'builtin', JSON.stringify(payload));
    assert.deepEqual(
      loaded.problems,
      [
        `Ignored ${resolveCompanionCatalogFile(home)}: not a usable catalog cache; /stereo:setup rewrites it.`,
      ],
      JSON.stringify(payload),
    );
  }
  assert.deepEqual(loadCodexCatalog({ codexHome: makeTempDir() }).problems, []);
});

test('writeCodexCatalogCache persists the live list without derived fields and refreshes the memo', () => {
  const home = makeTempDir();
  assert.equal(loadCodexCatalog({ codexHome: home }).source, 'builtin');
  const live = [
    liveModel('gpt-6-astra', { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
    liveModel('gpt-5.5', { efforts: ['low', 'medium', 'high', 'xhigh'] }),
  ];
  const models = live.map((model) => fromLiveModel(model)).filter((model) => model !== null);
  const written = writeCodexCatalogCache(models, {
    codexHome: home,
    fetchedAt: '2026-09-24T12:00:00.000Z',
  });

  assert.equal(written.source, 'companion');
  assert.equal(written.path, resolveCompanionCatalogFile(home));
  assert.deepEqual(written.problems, []);
  const onDisk = JSON.parse(fs.readFileSync(written.path as string, 'utf8')) as {
    version: number;
    fetchedAt: string;
    models: Array<Record<string, unknown>>;
  };
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.fetchedAt, '2026-09-24T12:00:00.000Z');
  assert.deepEqual(onDisk.models, [
    { id: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ]);
  assert.equal(loadCodexCatalog({ codexHome: home }), written, 'the memo is refreshed');
});

test('a failed cache write still serves the live list in-process and says it was not persisted', () => {
  const home = makeTempDir();
  // companion-state as a file makes the mkdir fail, so the write throws.
  fs.writeFileSync(path.join(home, 'companion-state'), 'not a directory', 'utf8');
  const live = [fromLiveModel(liveModel('gpt-6-sol'))].filter((model) => model !== null);
  const written = writeCodexCatalogCache(live, { codexHome: home });
  const served = loadCodexCatalog({ codexHome: home });
  assert.equal(served, written, 'the returned catalog is the one the memo serves');
  assert.equal(served.source, 'companion');
  assert.equal(served.path, null, 'nothing on disk backs the served list');
  assert.deepEqual(
    served.models.map((model) => model.id),
    ['gpt-6-sol'],
  );
  assert.match(
    served.problems[0]!,
    /^Could not write the Codex catalog cache .*codex-models\.json: /,
  );
  assert.match(
    describeCodexCatalogSource(served),
    /^live Codex catalog fetched .* \(not persisted\)$/,
  );
});

test('a failed fetch is recorded against whatever catalog is in effect', () => {
  const home = makeTempDir();
  recordCatalogFetchFailure('Unsupported method: model/list', home);
  const floor = loadCodexCatalog({ codexHome: home });
  assert.deepEqual(floor.problems, [
    'Codex model/list failed (Unsupported method: model/list); showing the built-in snapshot.',
  ]);

  writeCodexCatalogCache([catalogEntry('gpt-6-sol')], {
    codexHome: home,
    fetchedAt: '2026-09-17T09:00:00.000Z',
  });
  recordCatalogFetchFailure('timed out after 3000ms', home);
  assert.deepEqual(loadCodexCatalog({ codexHome: home }).problems, [
    'Codex model/list failed (timed out after 3000ms); showing the catalog fetched 2026-09-17T09:00:00.000Z.',
  ]);
});

test('fromLiveModel keys on the slug the runtime accepts and reads the shape defensively', () => {
  assert.equal(fromLiveModel({} as Model), null);
  const fromModelField = fromLiveModel(
    liveModel('ignored', { id: undefined, model: 'gpt-6-luna' }),
  );
  assert.equal(fromModelField?.id, 'gpt-6-luna');
  assert.equal(fromModelField?.family, 'luna');
  // A preset whose picker id differs from its slug resolves to the slug.
  const preset = fromLiveModel(liveModel('gpt-6-luna-fast', { model: 'gpt-6-luna' }));
  assert.equal(preset?.id, 'gpt-6-luna');
  assert.equal(fromLiveModel(liveModel('picker-only', { model: undefined }))?.id, 'picker-only');
  const messy = fromLiveModel(
    liveModel('gpt-6-sol', {
      supportedReasoningEfforts: [
        { reasoningEffort: 'ultra' },
        { reasoningEffort: 'low' },
        'max',
        7,
      ],
    }),
  );
  assert.deepEqual(messy?.efforts, ['low', 'max', 'ultra']);
});

test('isCodexCatalogFresh trusts only a recent, past-dated companion fetch', () => {
  const recent = catalogFixture([catalogEntry('gpt-6-sol')], {
    fetchedAt: new Date().toISOString(),
  });
  assert.equal(isCodexCatalogFresh(recent, 60_000), true);
  assert.equal(
    isCodexCatalogFresh(
      catalogFixture([catalogEntry('gpt-6-sol')], {
        fetchedAt: new Date(Date.now() - 120_000).toISOString(),
      }),
      60_000,
    ),
    false,
  );
  // A stamp from the future (clock skew, copied file) must not suppress refreshes.
  assert.equal(
    isCodexCatalogFresh(
      catalogFixture([catalogEntry('gpt-6-sol')], {
        fetchedAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      60_000,
    ),
    false,
  );
  assert.equal(isCodexCatalogFresh({ ...recent, fetchedAt: 'yesterday' }, 60_000), false);
  assert.equal(isCodexCatalogFresh(builtinCatalog(), 60_000), false);
});

test('catalog families list alphabetically, each family newest version first', () => {
  const catalog = catalogFixture([
    catalogEntry('gpt-5.6-sol'),
    catalogEntry('gpt-6-sol'),
    catalogEntry('gpt-5.6.1-sol'),
    catalogEntry('gpt-5.6-terra'),
    catalogEntry('gpt-5.5'),
  ]);
  assert.deepEqual(listCodexCatalogFamilies(catalog), ['sol', 'terra']);
  assert.deepEqual(
    catalogFamilyVersions(catalog, 'sol').map((model) => model.id),
    ['gpt-6-sol', 'gpt-5.6.1-sol', 'gpt-5.6-sol'],
  );
  assert.deepEqual(catalogFamilyVersions(catalog, 'nova'), []);
});

test('defaultCatalogEffort gives xhigh, stepping down to a tier the model lists', () => {
  const catalog = catalogFixture([
    catalogEntry('gpt-6-astra', { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
    catalogEntry('gpt-6-sol', { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
    catalogEntry('gpt-5.5', { efforts: ['low', 'medium', 'high', 'xhigh'] }),
    catalogEntry('gpt-5-lite', { efforts: ['low', 'medium', 'high'] }),
    catalogEntry('gpt-7-lite', { efforts: ['low', 'ultra'] }),
    catalogEntry('gpt-7-top', { efforts: ['max', 'ultra'] }),
    catalogEntry('gpt-7-blank', { efforts: [] }),
    catalogEntry('kimi-k3', { efforts: ['low', 'max'] }),
  ]);
  assert.equal(defaultCatalogEffort('gpt-6-astra', catalog), 'xhigh');
  assert.equal(defaultCatalogEffort('gpt-6-sol', catalog), 'xhigh');
  assert.equal(defaultCatalogEffort('gpt-5.5', catalog), 'xhigh');
  // The default is capped by what the model lists.
  assert.equal(defaultCatalogEffort('gpt-5-lite', catalog), 'high');
  assert.equal(defaultCatalogEffort('gpt-7-lite', catalog), 'low');
  // Nothing listed at or below the default: no override, never max or ultra.
  assert.equal(defaultCatalogEffort('gpt-7-top', catalog), null);
  // No tiers listed or not in the catalog: the default unchecked.
  assert.equal(defaultCatalogEffort('gpt-7-blank', catalog), 'xhigh');
  assert.equal(defaultCatalogEffort('gpt-8-unknown', catalog), 'xhigh');
  assert.equal(defaultCatalogEffort('kimi-k3', catalog), 'low', 'a listed model uses its tiers');
  assert.equal(defaultCatalogEffort('some-chat-model', catalog), null);
});

test('assertCodexEffortListed refuses an explicit effort the resolved model does not list', () => {
  const catalog = catalogFixture([
    catalogEntry('gpt-6-luna', { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    catalogEntry('gpt-5.5', { efforts: ['low', 'medium', 'high', 'xhigh'] }),
    catalogEntry('gpt-7-blank', { efforts: [] }),
  ]);
  for (const effort of ['low', 'max', 'none', null, undefined, '']) {
    assert.doesNotThrow(
      () => assertCodexEffortListed('gpt-6-luna', effort, catalog),
      String(effort),
    );
  }
  assert.throws(
    () => assertCodexEffortListed('gpt-6-luna', 'ultra', catalog),
    new Error(
      'Effort ultra is not a tier codex:luna (gpt-6-luna) lists; the catalog lists low, medium, high, xhigh, max.',
    ),
  );
  assert.throws(
    () => assertCodexEffortListed('gpt-5.5', 'minimal', catalog),
    new Error(
      'Effort minimal is not a tier gpt-5.5 lists; the catalog lists low, medium, high, xhigh.',
    ),
  );
  // No tiers listed, a model the catalog does not know, and a
  // provider-qualified id are unchecked.
  assert.doesNotThrow(() => assertCodexEffortListed('gpt-7-blank', 'ultra', catalog));
  assert.doesNotThrow(() => assertCodexEffortListed('gpt-8-unknown', 'ultra', catalog));
  assert.doesNotThrow(() => assertCodexEffortListed('gpt-6-luna@azure', 'ultra', catalog));
});

test('catalog sources render for people', () => {
  assert.equal(
    describeCodexCatalogSource({
      source: 'companion',
      fetchedAt: '2026-09-24T10:00:00.000Z',
      path: '/x',
    }),
    'live Codex catalog fetched 2026-09-24T10:00:00.000Z',
  );
  assert.equal(
    describeCodexCatalogSource({ source: 'builtin', fetchedAt: null, path: null }),
    'built-in snapshot (no catalog fetched yet; /stereo:setup refreshes it)',
  );
});

test('a raw Codex id in another case resolves to the catalog slug and its tiers', () => {
  const resolve = (model: string) => resolveCodexSelection(parseCodexSelection(model)!, catalog);
  assert.equal(resolve('codex:GPT-6-Astra'), 'gpt-6-astra');
  assert.equal(resolve('GPT-5.5'), 'gpt-5.5');
  assert.equal(resolve('GPT-6-Astra@azure'), 'GPT-6-Astra@azure', 'provider ids keep their case');
  assert.equal(defaultModelEffort('GPT-6-Astra', { catalog }), 'xhigh');
  assert.equal(defaultCatalogEffort('GPT-5.5', catalog), 'xhigh');
  assert.throws(
    () => assertCodexEffortListed('GPT-6-ASTRA', 'minimal', catalog),
    /^Error: Effort minimal is not a tier codex:astra \(gpt-6-astra\) lists/,
  );
});
