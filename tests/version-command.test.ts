import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { makeTempDir, run } from './helpers.ts';
import { registerBrokerReaping, ROOT, SCRIPT } from './runtime-helpers.ts';
import { PLUGIN_MANIFEST_FILE } from '../plugins/stereo/src/shared/paths.ts';
import { readPluginManifestVersion } from '../plugins/stereo/src/shared/plugin-manifest.ts';

registerBrokerReaping();

const MANIFEST = path.join(ROOT, 'plugins', 'stereo', '.claude-plugin', 'plugin.json');
const manifestVersion: string = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;

function runCompanion(args: string[]) {
  return run(process.execPath, [SCRIPT, ...args], { cwd: ROOT });
}

test('version prints the shipped plugin manifest version as plain text and JSON', () => {
  assert.match(manifestVersion, /^\d+\.\d+\.\d+/);

  const plain = runCompanion(['version']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, `${manifestVersion}\n`);
  assert.equal(plain.stderr, '');

  const json = runCompanion(['version', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { version: manifestVersion });
});

test('the CLI usage surface lists the version subcommand', () => {
  const result = runCompanion(['help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-companion\.ts version \[--json\]/);
});

test('version rejects positional arguments with the --json error contract', () => {
  const expected = 'version takes only flags; unexpected positional arguments.';
  const result = runCompanion(['version', 'extra', '--json']);

  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error, expected);
  assert.equal(result.stderr.trim(), expected);
});

test('readPluginManifestVersion resolves the shipped manifest and fails closed', () => {
  assert.equal(PLUGIN_MANIFEST_FILE, MANIFEST);
  assert.equal(readPluginManifestVersion(), manifestVersion);

  const fixtures = makeTempDir();

  const missing = path.join(fixtures, 'absent', 'plugin.json');
  assert.throws(
    () => readPluginManifestVersion(missing),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(`Could not read the plugin manifest ${missing}: `),
  );

  const malformed = path.join(fixtures, 'malformed.json');
  fs.writeFileSync(malformed, 'not json', 'utf8');
  assert.throws(
    () => readPluginManifestVersion(malformed),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `Could not parse the plugin manifest ${malformed} as JSON.`,
  );

  const untyped = path.join(fixtures, 'untyped.json');
  fs.writeFileSync(untyped, '{"version": 3}', 'utf8');
  assert.throws(
    () => readPluginManifestVersion(untyped),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `The plugin manifest ${untyped} has no string "version" field.`,
  );
});
