import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildProviderProbeConfig,
  parseProviderProbeArgs,
  parseProviderStanza,
} from '../scripts/provider-probe.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir, run } from './helpers.ts';
import { registerBrokerReaping } from './runtime-helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'scripts', 'provider-probe.ts');

registerBrokerReaping();

const STANZA = [
  '[model_providers.acme]',
  'name = "Acme Responses"',
  'base_url = "http://127.0.0.1:9876/v1"',
  'env_key = "ACME_API_KEY"',
  'wire_api = "responses"',
  '',
].join('\n');

test('provider stanza parsing enforces a single Responses provider', () => {
  assert.deepEqual(parseProviderStanza(STANZA), {
    providerId: 'acme',
    envKey: 'ACME_API_KEY',
  });
  assert.deepEqual(
    parseProviderStanza(
      [
        '[model_providers."quoted-provider"]',
        'base_url = "http://127.0.0.1:9876/v1"',
        'wire_api = "responses"',
      ].join('\n'),
    ),
    {
      providerId: 'quoted-provider',
      envKey: null,
    },
  );
  assert.throws(
    () => parseProviderStanza(STANZA.replace('"responses"', '"chat"')),
    /must set wire_api = "responses"/,
  );
  assert.throws(
    () => parseProviderStanza(`${STANZA}\n[model_providers.second]\nwire_api = "responses"\n`),
    /Expected exactly one/,
  );
});

test('provider config builder pins the model and provider without changing the stanza', () => {
  const config = buildProviderProbeConfig(STANZA, 'acme-code', 'acme');
  assert.match(config, /^model = "acme-code"\nmodel_provider = "acme"\n/);
  assert.match(config, /\[model_providers\.acme\]/);
  assert.match(config, /wire_api = "responses"/);
});

test('provider probe is registered as an npm script and parses its public CLI', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['provider-probe'], 'node scripts/provider-probe.ts');
  assert.deepEqual(
    parseProviderProbeArgs(['--config', './provider.toml', '--model', 'acme-code', '--live']),
    {
      configPath: path.resolve('./provider.toml'),
      model: 'acme-code',
      live: true,
      help: false,
    },
  );
  assert.throws(() => parseProviderProbeArgs(['--model', 'acme-code']), /--config is required/);
});

test('provider probe initializes config and exercises live tool and follow-up turns', () => {
  const fixtureDir = makeTempDir();
  const binDir = makeTempDir();
  const configPath = path.join(fixtureDir, 'provider.toml');
  const statePath = path.join(binDir, 'fake-codex-state.json');
  fs.writeFileSync(configPath, STANZA, 'utf8');
  installFakeCodex(binDir, 'provider-probe');
  const env = {
    ...buildEnv(binDir),
    ACME_API_KEY: 'test-only-key',
  };

  const parseOnly = run('node', [PROBE, '--config', configPath, '--model', 'acme-code'], {
    cwd: ROOT,
    env,
  });

  assert.equal(parseOnly.status, 0, JSON.stringify(parseOnly, null, 2));
  assert.match(parseOnly.stdout, /Codex parsed the provider config/);
  assert.match(parseOnly.stdout, /Live endpoint check skipped/);
  const parseState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.match(parseState.configContents, /^model = "acme-code"\nmodel_provider = "acme"/);
  assert.match(parseState.configContents, /wire_api = "responses"/);
  assert.equal(parseState.lastThreadStart, undefined);

  const live = run('node', [PROBE, '--config', configPath, '--model', 'acme-code', '--live'], {
    cwd: ROOT,
    env,
  });

  assert.equal(live.status, 0, JSON.stringify(live, null, 2));
  assert.match(live.stdout, /Live provider probe passed/);
  const liveState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(liveState.lastThreadStart.model, 'acme-code');
  assert.equal(liveState.lastThreadStart.modelProvider, 'acme');
  assert.equal(liveState.turnStarts.length, 2);
});
