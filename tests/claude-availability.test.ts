import assert from 'node:assert/strict';
import test from 'node:test';

import { PROBE_TIMEOUT_MS } from '../plugins/stereo/src/platform/process.ts';
import type { CommandResult, RunCommandFn } from '../plugins/stereo/src/platform/process.ts';
import {
  CLAUDE_MIN_VERSION,
  getClaudeAuthStatus,
  getClaudeAvailability,
  parseClaudeVersion,
} from '../plugins/stereo/src/runtime/claude-availability.ts';
import { CLAUDE_EXECPATH_ENV } from '../plugins/stereo/src/transport/claude-cli.ts';

interface RecordedProbe {
  command: string;
  args: readonly string[];
  shell: boolean | string | undefined;
  timeout?: number;
}

interface FakeCliResponses {
  version?: Partial<CommandResult>;
  auth?: Partial<CommandResult>;
}

// A `claude` CLI answered from a table: `--version` and `auth status --json`
// are the only commands the probes run, and every call is recorded.
function fakeCli(responses: FakeCliResponses = {}, probes: RecordedProbe[] = []): RunCommandFn {
  return (command, args = [], options = {}) => {
    probes.push({ command, args, shell: options.shell, timeout: options.timeout });
    const base: CommandResult = {
      command,
      args,
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: null,
    };
    if (args[0] === '--version') {
      return { ...base, stdout: '2.1.281 (Claude Code)\n', ...responses.version };
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return { ...base, stdout: `${JSON.stringify({ loggedIn: true })}\n`, ...responses.auth };
    }
    throw new Error(`unexpected probe: ${command} ${args.join(' ')}`);
  };
}

const CWD = '/work/repo';

test('parseClaudeVersion reads the first dotted triple and nothing else', () => {
  assert.equal(parseClaudeVersion('2.1.281 (Claude Code)'), '2.1.281');
  assert.equal(parseClaudeVersion('Claude Code v10.0.3-beta.2'), '10.0.3');
  assert.equal(parseClaudeVersion('Claude Code CLI'), null);
  assert.equal(parseClaudeVersion(''), null);
});

test('an unparsable version is unavailable and names the output', () => {
  const probes: RecordedProbe[] = [];
  const availability = getClaudeAvailability(CWD, {
    env: {},
    runCommandImpl: fakeCli({ version: { stdout: 'Claude Code CLI\n' } }, probes),
  });
  assert.deepEqual(availability, {
    available: false,
    detail: 'Claude Code CLI; version could not be parsed',
    version: null,
    binary: 'claude',
  });
  assert.deepEqual(
    probes.map((probe) => [probe.command, ...probe.args]),
    [['claude', '--version']],
  );
});

test('a version below the minimum is unavailable and the auth probe never runs', () => {
  const probes: RecordedProbe[] = [];
  const runCommandImpl = fakeCli({ version: { stdout: '2.1.200 (Claude Code)\n' } }, probes);
  const availability = getClaudeAvailability(CWD, { env: {}, runCommandImpl });
  assert.deepEqual(availability, {
    available: false,
    detail: `2.1.200 (Claude Code); Claude roles need Claude Code ${CLAUDE_MIN_VERSION} or newer (run \`claude update\`)`,
    version: '2.1.200',
    binary: 'claude',
  });
  const auth = getClaudeAuthStatus(CWD, { env: {}, runCommandImpl });
  assert.deepEqual(auth, { available: false, loggedIn: false, detail: availability.detail });
  assert.equal(
    probes.filter((probe) => probe.args[0] === 'auth').length,
    0,
    'an unavailable CLI is never asked for its login',
  );
});

test('a missing binary reads as not found and a spawn failure carries its message', () => {
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(
    getClaudeAvailability(CWD, {
      env: {},
      runCommandImpl: fakeCli({ version: { error: enoent } }),
    }),
    { available: false, detail: 'not found', version: null, binary: 'claude' },
  );
  const eacces = Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' });
  assert.equal(
    getClaudeAvailability(CWD, { env: {}, runCommandImpl: fakeCli({ version: { error: eacces } }) })
      .detail,
    'spawn claude EACCES',
  );
  assert.equal(
    getClaudeAvailability(CWD, {
      env: {},
      runCommandImpl: fakeCli({ version: { status: 2, stderr: 'boom\n' } }),
    }).detail,
    'boom',
  );
});

test('a probe that never answers is bounded and reads as a failure that says so', () => {
  const probes: RecordedProbe[] = [];
  const timedOut = Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' });
  assert.deepEqual(
    getClaudeAvailability(CWD, {
      env: {},
      runCommandImpl: fakeCli({ version: { error: timedOut } }, probes),
    }),
    {
      available: false,
      detail: `claude --version timed out after ${PROBE_TIMEOUT_MS} ms`,
      version: null,
      binary: 'claude',
    },
  );
  const auth = getClaudeAuthStatus(CWD, {
    env: {},
    runCommandImpl: fakeCli({ auth: { error: timedOut, stdout: '' } }, probes),
  });
  assert.equal(auth.available, true);
  assert.equal(auth.loggedIn, false);
  assert.equal(
    auth.detail,
    `claude auth status timed out after ${PROBE_TIMEOUT_MS} ms; login unknown`,
  );
  // Every probe carries the bound.
  assert.deepEqual(
    probes.map((probe) => probe.timeout),
    [PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS],
  );
});

test('an auth probe that exits 1 with non-JSON output is not logged in', () => {
  const auth = getClaudeAuthStatus(CWD, {
    env: {},
    runCommandImpl: fakeCli({
      auth: { status: 1, stdout: 'Not logged in. Run claude auth login.\n' },
    }),
  });
  assert.deepEqual(auth, {
    available: true,
    loggedIn: false,
    detail: 'not logged in (Not logged in. Run claude auth login.); run `claude auth login`',
  });
});

test('an auth probe that exits 0 with loggedIn:false is not logged in either', () => {
  const auth = getClaudeAuthStatus(CWD, {
    env: {},
    runCommandImpl: fakeCli({
      auth: { status: 0, stdout: '{"loggedIn":false,"authMethod":"claude.ai"}\n' },
    }),
  });
  assert.equal(auth.available, true);
  assert.equal(auth.loggedIn, false);
  assert.equal(
    auth.detail,
    'not logged in ({"loggedIn":false,"authMethod":"claude.ai"}); run `claude auth login`',
  );
});

test('credentials in the environment stand in for a login auth status does not report', () => {
  const loggedOut = fakeCli({ auth: { status: 1, stdout: '{"loggedIn":false}\n' } });
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ]) {
    assert.deepEqual(
      getClaudeAuthStatus(CWD, { env: { [key]: '1' }, runCommandImpl: loggedOut }),
      {
        available: true,
        loggedIn: true,
        detail: `no Claude login; using ${key} from the environment`,
      },
      key,
    );
  }
  // An empty variable is no credential.
  const blank = getClaudeAuthStatus(CWD, {
    env: { ANTHROPIC_API_KEY: ' ' },
    runCommandImpl: loggedOut,
  });
  assert.equal(blank.loggedIn, false);
});

test('a logged-in account is described with its email and plan', () => {
  const auth = getClaudeAuthStatus(CWD, {
    env: {},
    runCommandImpl: fakeCli({
      auth: {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'dev@example.com',
          subscriptionType: 'max',
        }),
      },
    }),
  });
  assert.deepEqual(auth, {
    available: true,
    loggedIn: true,
    detail: 'Claude login active for dev@example.com (max)',
  });
  // Exit 0 with no readable JSON still counts as logged in, anonymously.
  const anonymous = getClaudeAuthStatus(CWD, {
    env: {},
    runCommandImpl: fakeCli({ auth: { stdout: 'ok\n' } }),
  });
  assert.equal(anonymous.loggedIn, true);
  assert.equal(anonymous.detail, 'Claude login active');
});

test('the probes name the binary and leave how it launches to the command runner', () => {
  // The binary from CLAUDE_CODE_EXECPATH is probed as named (its one
  // --version answer both names it Claude Code and gives the version), a bare
  // name as `claude`; no probe forces a shell, so resolveCommandLaunch decides
  // per platform (a native binary directly, an npm shim's script under this
  // Node).
  const explicitProbes: RecordedProbe[] = [];
  const explicitBinary = 'C:\\Program Files\\Claude\\claude.exe';
  const explicit = getClaudeAuthStatus(CWD, {
    env: { [CLAUDE_EXECPATH_ENV]: explicitBinary },
    runCommandImpl: fakeCli({}, explicitProbes),
  });
  assert.equal(explicit.loggedIn, true);
  assert.deepEqual(
    explicitProbes.map((probe) => [probe.command, probe.args[0], probe.shell]),
    [
      [explicitBinary, '--version', undefined],
      [explicitBinary, 'auth', undefined],
    ],
  );
  const bareProbes: RecordedProbe[] = [];
  getClaudeAuthStatus(CWD, { env: {}, runCommandImpl: fakeCli({}, bareProbes) });
  assert.deepEqual(
    bareProbes.map((probe) => [probe.command, probe.args[0], probe.shell]),
    [
      ['claude', '--version', undefined],
      ['claude', 'auth', undefined],
    ],
  );
});
