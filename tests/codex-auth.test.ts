import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { loadCodexCatalog, writeCodexCatalogCache } from '../plugins/stereo/src/models/catalog.ts';
import { resetCodexAvailabilityCache } from '../plugins/stereo/src/runtime/availability.ts';
import { getCodexAuthStatus } from '../plugins/stereo/src/runtime/auth.ts';
import type { AppServerClient } from '../plugins/stereo/src/runtime/threads.ts';
import { installFakeCodex } from './fake-codex-fixture.ts';
import { accountCatalogModels, liveModel, makeTempDir, useTempCodexHome } from './helpers.ts';

// The availability probe spawns `codex --version`; point PATH at the fake so
// the auth probe reaches its connection step on every machine. The connection
// itself is injected below, so no app-server or broker is ever started.
const binDir = makeTempDir();
installFakeCodex(binDir);
const sep = process.platform === 'win32' ? ';' : ':';
process.env.PATH = `${binDir}${sep}${process.env.PATH ?? ''}`;
resetCodexAvailabilityCache();

function fakeClient(behavior: {
  account?: 'ok' | 'reject';
  models?: 'ok' | 'reject';
  modelsDelayMs?: number;
}): AppServerClient {
  return {
    request: async (method: string) => {
      if (method === 'account/read') {
        if (behavior.account === 'reject') {
          throw new Error('token expired');
        }
        return { account: { type: 'chatgpt', email: 'dev@example.com' }, requiresOpenaiAuth: true };
      }
      if (method === 'config/read') {
        return { config: { model_provider: 'openai' }, origins: {}, layers: null };
      }
      if (method === 'model/list') {
        await new Promise((resolve) => setTimeout(resolve, behavior.modelsDelayMs ?? 0));
        if (behavior.models === 'reject') {
          throw new Error('Unsupported method: model/list');
        }
        return { data: [liveModel('gpt-6-astra'), liveModel('gpt-6-sol')], nextCursor: null };
      }
      throw new Error(`unexpected ${method}`);
    },
    close: async () => {},
  } as unknown as AppServerClient;
}

test('a connection failure during a forced refresh is recorded as a catalog problem', async (t) => {
  useTempCodexHome(t);
  const cwd = makeTempDir();
  const status = await getCodexAuthStatus(cwd, {
    forceCatalogRefresh: true,
    connectImpl: async () => {
      throw new Error('broker socket refused');
    },
  });
  assert.equal(status.loggedIn, false);
  assert.equal(status.detail, 'broker socket refused');
  assert.deepEqual(loadCodexCatalog().problems, [
    'Codex model/list failed (connection failed: broker socket refused); showing the built-in snapshot.',
  ]);
  assert.equal(loadCodexCatalog().source, 'builtin');
});

test('an auth failure lets the in-flight model/list settle instead of recording a spurious failure', async (t) => {
  useTempCodexHome(t);
  const cwd = makeTempDir();
  assert.equal(loadCodexCatalog().source, 'builtin', 'a fresh home starts on the snapshot');
  const status = await getCodexAuthStatus(cwd, {
    forceCatalogRefresh: true,
    connectImpl: async () => fakeClient({ account: 'reject', modelsDelayMs: 30 }),
  });
  assert.equal(status.loggedIn, false);
  assert.equal(status.detail, 'token expired');
  const catalog = loadCodexCatalog();
  assert.equal(catalog.source, 'companion', 'the settled list was cached');
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ['gpt-6-astra', 'gpt-6-sol'],
  );
  assert.deepEqual(catalog.problems, [], 'the auth error is not a catalog failure');
});

test('a real model/list failure is recorded once against the served catalog', async (t) => {
  const codexHome = useTempCodexHome(t);
  // A catalog fetched earlier is what the failure is recorded against.
  writeCodexCatalogCache(accountCatalogModels(), {
    codexHome,
    fetchedAt: '2026-09-24T00:00:00.000Z',
  });
  const cwd = makeTempDir();
  const status = await getCodexAuthStatus(cwd, {
    forceCatalogRefresh: true,
    connectImpl: async () => fakeClient({ models: 'reject' }),
  });
  assert.equal(status.loggedIn, true);
  const catalog = loadCodexCatalog();
  assert.deepEqual(catalog.problems, [
    'Codex model/list failed (Unsupported method: model/list); showing the catalog fetched 2026-09-24T00:00:00.000Z.',
  ]);
  assert.equal(catalog.source, 'companion');
  assert.equal(path.isAbsolute(catalog.path ?? ''), true);
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    accountCatalogModels().map((model) => model.id),
    'the cached list is kept',
  );
});
