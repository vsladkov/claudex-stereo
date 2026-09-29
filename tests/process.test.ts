import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  binaryAvailable,
  buildCmdCommandLine,
  parseCmdShimTarget,
  quoteForCmd,
  resolveCommandLaunch,
  runCommand,
  signalProcessGroup,
  signalThenEscalate,
  terminateProcessTree,
} from '../plugins/stereo/src/platform/process.ts';
import type { TerminateProcessTreeOptions } from '../plugins/stereo/src/platform/process.ts';
import { fakeFiles, makeTempDir } from './helpers.ts';

// Signalling, command launch, and command runs. Process identity (who a
// recorded pid is now) is in process-identity.test.ts.

const esrch = (): Error => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

test('terminateProcessTree signals nothing for a non-positive, non-integer, or non-finite pid', () => {
  for (const pid of [0, -1, 12.5, Number.NaN]) {
    let killCalls = 0;
    let runCommandCalls = 0;

    for (const platform of ['linux', 'win32'] as const) {
      terminateProcessTree(pid, {
        platform,
        runCommandImpl() {
          runCommandCalls += 1;
          throw new Error('runCommandImpl must not run for an invalid pid');
        },
        killImpl() {
          killCalls += 1;
          throw new Error('killImpl must not run for an invalid pid');
        },
      });
    }

    assert.equal(runCommandCalls, 0);
    assert.equal(killCalls, 0);
  }
});

test('terminateProcessTree uses taskkill on Windows', () => {
  let captured = null;
  terminateProcessTree(1234, {
    platform: 'win32',
    runCommandImpl(command: string, args: readonly string[] = []) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
      };
    },
    killImpl() {
      throw new Error('kill fallback should not run');
    },
  });

  assert.deepEqual(captured, {
    command: 'taskkill',
    args: ['/PID', '1234', '/T', '/F'],
  });
});

test('a failed taskkill is judged by whether the pid still exists, never by its wording', () => {
  const failedTaskkill = (command: string, args: readonly string[] = []) => ({
    command,
    args,
    status: 128,
    signal: null,
    // Localized: nothing here says "not found" in English.
    stdout: 'FEHLER: Der Prozess "1234" wurde nicht gefunden.',
    stderr: '',
    error: null,
  });
  const probes: Array<NodeJS.Signals | number | undefined> = [];
  // Gone already: nothing is left to stop, and nothing is thrown.
  terminateProcessTree(1234, {
    platform: 'win32',
    runCommandImpl: failedTaskkill,
    killImpl(_pid, signal) {
      probes.push(signal);
      throw esrch();
    },
  });
  assert.deepEqual(probes, [0], 'only a liveness probe, never a signal');

  // Still running after taskkill failed: a real failure, surfaced.
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: 'win32',
        runCommandImpl: failedTaskkill,
        killImpl: () => true,
      }),
    /taskkill \/PID 1234 \/T \/F: exit=128/,
  );
});

test('terminateProcessTree falls back to the pid itself when the group kill fails', () => {
  // No group led by the pid (a foreground companion), or no permission on the
  // group: the process may still be alive, so the signal goes to the pid.
  for (const groupError of ['ESRCH', 'EPERM'] as const) {
    const calls: Array<[number, NodeJS.Signals | number | undefined]> = [];
    terminateProcessTree(4321, {
      platform: 'linux',
      runCommandImpl() {
        throw new Error('taskkill must not run outside Windows');
      },
      killImpl(pid, signal) {
        calls.push([pid, signal]);
        if (pid < 0) {
          throw Object.assign(new Error(`kill ${groupError}`), { code: groupError });
        }
      },
    });
    assert.deepEqual(
      calls,
      [
        [-4321, 'SIGTERM'],
        [4321, 'SIGTERM'],
      ],
      groupError,
    );
  }
});

test('a pid that is already gone is nothing to signal; any other failure surfaces', () => {
  assert.doesNotThrow(() =>
    terminateProcessTree(4321, {
      platform: 'linux',
      killImpl() {
        throw esrch();
      },
    }),
  );
  // Only ESRCH on the pid itself reads as "already gone"; anything else surfaces.
  assert.throws(
    () =>
      terminateProcessTree(4321, {
        platform: 'linux',
        killImpl(pid) {
          if (pid < 0) {
            throw esrch();
          }
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        },
      }),
    /EPERM/,
  );
});

test('a group-only signal never falls back to the pid itself', () => {
  const calls: number[] = [];
  // An empty group (ESRCH) is nothing to signal.
  terminateProcessTree(4321, {
    platform: 'linux',
    signal: 'SIGKILL',
    groupOnly: true,
    killImpl(pid) {
      calls.push(pid);
      throw esrch();
    },
  });
  assert.deepEqual(calls, [-4321]);
  assert.throws(
    () =>
      terminateProcessTree(4321, {
        platform: 'linux',
        groupOnly: true,
        killImpl() {
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        },
      }),
    /EPERM/,
  );
});

type SignalCall = [number, string, boolean];

function recordingTerminate(calls: SignalCall[]) {
  return (pid: number, options?: TerminateProcessTreeOptions): void => {
    calls.push([pid, options?.signal ?? 'SIGTERM', options?.groupOnly === true]);
  };
}

test('signalProcessGroup signals a running pid through its group, and an exited one only as a group', () => {
  const calls: SignalCall[] = [];
  const terminate = recordingTerminate(calls);
  signalProcessGroup({ pid: 7, isRunning: () => true }, 'SIGTERM', {
    platform: 'linux',
    terminate,
  });
  signalProcessGroup({ pid: 8, isRunning: () => false }, 'SIGKILL', {
    platform: 'linux',
    terminate,
  });
  // Windows: a tree kill needs a live root.
  signalProcessGroup({ pid: 9, isRunning: () => false }, 'SIGTERM', {
    platform: 'win32',
    terminate,
  });
  // A failed signal (already gone, not ours) is dropped.
  signalProcessGroup({ pid: 10, isRunning: () => true }, 'SIGTERM', {
    platform: 'linux',
    terminate: () => {
      throw new Error('kill EPERM');
    },
  });
  assert.deepEqual(calls, [
    [7, 'SIGTERM', false],
    [8, 'SIGKILL', true],
  ]);
});

test('signalThenEscalate from a timer skips the hard signal once the targets settled', async () => {
  const settledCalls: SignalCall[] = [];
  signalThenEscalate(
    { pid: 11, isRunning: () => true },
    {
      graceMs: 10,
      wait: 'timer',
      platform: 'linux',
      terminate: recordingTerminate(settledCalls),
      stillNeeded: () => false,
    },
  );
  const stubbornCalls: SignalCall[] = [];
  signalThenEscalate([{ pid: 13, isRunning: () => true }], {
    graceMs: 10,
    wait: 'timer',
    platform: 'linux',
    terminate: recordingTerminate(stubbornCalls),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(settledCalls, [[11, 'SIGTERM', false]]);
  assert.deepEqual(stubbornCalls, [
    [13, 'SIGTERM', false],
    [13, 'SIGKILL', false],
  ]);
});

test('signalThenEscalate signals every target even when one fails, and throws nothing', () => {
  const calls: SignalCall[] = [];
  const record = recordingTerminate(calls);
  signalThenEscalate(
    [
      { pid: 21, isRunning: () => true },
      { pid: 22, isRunning: () => true },
    ],
    {
      graceMs: 5,
      wait: 'sync',
      platform: 'linux',
      terminate: (pid, options) => {
        record(pid, options);
        if (pid === 21) {
          throw new Error('kill EPERM');
        }
      },
    },
  );
  assert.deepEqual(calls, [
    [21, 'SIGTERM', false],
    [22, 'SIGTERM', false],
    [21, 'SIGKILL', false],
    [22, 'SIGKILL', false],
  ]);
});

test('signalThenEscalate follows the polite signal with the hard one, to the group once the leader is gone', () => {
  const stubborn: SignalCall[] = [];
  signalThenEscalate(
    { pid: 4242, isRunning: () => true },
    { graceMs: 10, wait: 'sync', platform: 'linux', terminate: recordingTerminate(stubborn) },
  );
  assert.deepEqual(stubborn, [
    [4242, 'SIGTERM', false],
    [4242, 'SIGKILL', false],
  ]);

  // The leader obeyed and exited: its group (a helper that ignored the polite
  // signal) still gets the hard one, and the pid itself is left alone.
  let exited = false;
  const obedient: SignalCall[] = [];
  const recordObedient = recordingTerminate(obedient);
  signalThenEscalate(
    { pid: 4243, isRunning: () => !exited },
    {
      graceMs: 10,
      wait: 'sync',
      platform: 'linux',
      terminate: (pid, options) => {
        exited = true;
        recordObedient(pid, options);
      },
    },
  );
  assert.deepEqual(obedient, [
    [4243, 'SIGTERM', false],
    [4243, 'SIGKILL', true],
  ]);

  // Windows: taskkill /F is already the hard kill; nothing is escalated.
  const windows: SignalCall[] = [];
  signalThenEscalate(
    { pid: 4244, isRunning: () => true },
    { graceMs: 10, wait: 'sync', platform: 'win32', terminate: recordingTerminate(windows) },
  );
  assert.deepEqual(windows, [[4244, 'SIGTERM', false]]);
});

test('a command that outlives its timeout is killed and reported as timed out', () => {
  const started = Date.now();
  const hang = ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 20000)'];
  const result = runCommand(process.execPath, hang, { timeout: 300 });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.error?.message ?? '', / timed out after 300 ms$/);
  const probe = binaryAvailable(process.execPath, hang, { timeout: 300 });
  assert.equal(probe.available, false);
  assert.match(probe.detail, / timed out after 300 ms$/);
  assert.ok(Date.now() - started < 10000, 'a SIGTERM the child ignores did not hold the caller');
});

test(
  'a command a signal ended is a failed command, never exit 0',
  { skip: process.platform === 'win32' },
  () => {
    const killed = ['-e', 'process.stdout.write("partial"); process.kill(process.pid, "SIGKILL")'];
    const result = runCommand(process.execPath, killed);
    assert.equal(result.signal, 'SIGKILL');
    assert.notEqual(result.status, 0);
    assert.equal(binaryAvailable(process.execPath, killed).available, false);
  },
);

test('quoteForCmd quotes for the C runtime and the cmd.exe fallback refuses what cmd would expand or split, by name', () => {
  // Plain tokens pass through untouched; the rest is quoted, trailing
  // backslashes doubled so they cannot escape the closing quote.
  assert.equal(quoteForCmd('--output-format'), '--output-format');
  assert.equal(quoteForCmd('C:\\tools\\claude.cmd'), 'C:\\tools\\claude.cmd');
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteForCmd('C:\\my dir\\'), '"C:\\my dir\\\\"');
  assert.equal(quoteForCmd(''), '""');

  const launch = (args: readonly string[]) =>
    resolveCommandLaunch('C:\\npm\\codex.cmd', args, { platform: 'win32' });
  // `%VAR%` expands even inside quotes.
  assert.throws(() => launch(['--label', '100%']), /the argument "100%" .*a %, which cmd\.exe/);
  // Every `\"` the C runtime keeps literal still toggles cmd's quote state,
  // so an operator between two JSON quotes would reach the shim's `%*`
  // re-parse unquoted, where no `^` escape survives.
  assert.throws(
    () => launch(['--json', '{"a":"b|c"}']),
    /the argument "\{\\"a\\":\\"b\|c\\"\}" .*next to a double quote/,
  );
  // An odd quote count leaves cmd's quote state open for the next argument.
  assert.throws(() => launch(['say "hi', 'a|b']), /the argument "a\|b" /);
  assert.throws(() => buildCmdCommandLine(['claude', 'line\nbreak']), /a line break/);
  // Balanced quotes, and operators inside a clean quoted span, pass.
  assert.equal(buildCmdCommandLine(['a|b&c<d>e']), '"a|b&c<d>e"');
  assert.equal(buildCmdCommandLine(['{"disableAllHooks":true}']), '"{\\"disableAllHooks\\":true}"');
  assert.deepEqual(launch(['-c', 'sandbox_mode="workspace-write"', 'a|b']), {
    file: 'C:\\npm\\codex.cmd -c "sandbox_mode=\\"workspace-write\\"" "a|b"',
    args: [],
    shell: true,
  });
});

test('POSIX commands never get a shell by default', () => {
  assert.deepEqual(resolveCommandLaunch('git', ['status', '--short'], { platform: 'linux' }), {
    file: 'git',
    args: ['status', '--short'],
    shell: false,
  });
  assert.deepEqual(resolveCommandLaunch('/usr/local/bin/claude', ['-p'], { platform: 'linux' }), {
    file: '/usr/local/bin/claude',
    args: ['-p'],
    shell: false,
  });
  assert.deepEqual(resolveCommandLaunch('codex.cmd', [], { platform: 'darwin' }), {
    file: 'codex.cmd',
    args: [],
    shell: false,
  });
});

test('a Windows bare name that resolves only to a batch shim runs through cmd.exe, quoted', () => {
  const env = { Path: 'C:\\Windows\\System32;"C:\\Users\\A B\\npm"' };
  const fileExists = fakeFiles('C:\\Users\\A B\\npm\\codex.cmd');
  assert.deepEqual(
    resolveCommandLaunch('codex', ['exec', '--json', '{"a":"b"}', 'x|y'], {
      platform: 'win32',
      env,
      fileExists,
    }),
    { file: 'codex exec --json "{\\"a\\":\\"b\\"}" "x|y"', args: [], shell: true },
  );
});

test('a Windows bare name with an executable anywhere on PATH, or none at all, runs without a shell', () => {
  const env = { PATH: 'C:\\npm;C:\\tools' };
  // The shell-less spawn finds codex.exe in the later directory itself.
  const both = fakeFiles('C:\\npm\\codex.cmd', 'C:\\tools\\codex.exe');
  assert.deepEqual(
    resolveCommandLaunch('codex', ['--version'], { platform: 'win32', env, fileExists: both }),
    { file: 'codex', args: ['--version'], shell: false },
  );
  // Nothing found: no shell, so the spawn fails as ENOENT ("not found").
  assert.deepEqual(
    resolveCommandLaunch('codex', ['--version'], {
      platform: 'win32',
      env,
      fileExists: fakeFiles(),
    }),
    { file: 'codex', args: ['--version'], shell: false },
  );
});

test('an explicit Windows path is spawned as given unless it names a batch script', () => {
  let lookups = 0;
  const fileExists = (): boolean => {
    lookups += 1;
    return true;
  };
  for (const command of ['node.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\tools\\codex']) {
    assert.deepEqual(
      resolveCommandLaunch(command, ['/PID', '12'], { platform: 'win32', fileExists }),
      { file: command, args: ['/PID', '12'], shell: false },
    );
  }
  assert.equal(lookups, 0, 'a path or an extension skips the PATH lookup');
  assert.deepEqual(
    resolveCommandLaunch('C:\\Program Files\\nodejs\\npm.CMD', ['--version'], {
      platform: 'win32',
      fileExists,
    }),
    { file: '"C:\\Program Files\\nodejs\\npm.CMD" --version', args: [], shell: true },
  );
});

test('a Windows npm shim runs its script under this Node, with no shell', () => {
  // The shim npm writes for a global `codex`: its node.exe reference comes
  // first, and `%*` re-parses every argument through cmd.exe, which would
  // refuse the JSON below.
  const npmDir = 'C:\\Users\\A B\\AppData\\Roaming\\npm';
  const codexShim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n');
  // VS Code's shim runs its cli.js under Code.exe, never under Node.
  const codeDir = 'C:\\VS Code\\bin';
  const codeShim = '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\n';
  const shims: Record<string, string> = {
    [`${npmDir}\\codex.cmd`]: codexShim,
    [`${codeDir}\\code.cmd`]: codeShim,
  };
  const script = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const options = {
    platform: 'win32' as const,
    env: { Path: `C:\\Windows\\System32;${npmDir};${codeDir}` },
    fileExists: fakeFiles(
      `${npmDir}\\codex.cmd`,
      `${npmDir}\\node.exe`,
      script,
      `${codeDir}\\code.cmd`,
      'C:\\VS Code\\resources\\app\\out\\cli.js',
    ),
    readFile: (file: string): string | null => shims[file] ?? null,
  };
  const args = ['exec', '--json', '{"a":"b|c"}'];
  assert.deepEqual(resolveCommandLaunch('codex', args, options), {
    file: process.execPath,
    args: [script, ...args],
    shell: false,
  });
  assert.deepEqual(resolveCommandLaunch(`${npmDir}\\codex.cmd`, args, options), {
    file: process.execPath,
    args: [script, ...args],
    shell: false,
  });
  assert.deepEqual(resolveCommandLaunch('code', ['plan.md'], options), {
    file: 'code plan.md',
    args: [],
    shell: true,
  });
});

test('parseCmdShimTarget finds the script a shim runs, never an executable', () => {
  const dir = makeTempDir();
  // The fixture's own shim: `node "%~dp0claude" %*`.
  fs.writeFileSync(path.join(dir, 'claude'), '');
  assert.equal(
    parseCmdShimTarget('@echo off\r\nnode "%~dp0claude" %*\r\n', dir),
    path.join(dir, 'claude'),
  );
  // A shim whose target is missing yields nothing, so the caller falls back.
  assert.equal(parseCmdShimTarget('node "%~dp0missing.js" %*', dir), null);
  // The npm shim names its node.exe before its cli.js; with only the
  // executable present there is no script to run at all.
  const npmShim =
    'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n' +
    '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  assert.equal(parseCmdShimTarget(npmShim, dir), null);
  // Nor is any other executable a candidate.
  for (const name of ['claude.cmd', 'claude.bat', 'claude.com']) {
    fs.writeFileSync(path.join(dir, name), '');
    assert.equal(parseCmdShimTarget(`node "%~dp0${name}" %*`, dir), null, name);
  }
});

test('a JavaScript entry runs under this Node on every platform', () => {
  // An npm install's cli.js named directly (CLAUDE_CODE_EXECPATH, a config
  // value) is not executable by itself anywhere; the platform only decides
  // what happens to non-script binaries.
  for (const platform of ['linux', 'win32'] as const) {
    for (const entry of ['/x/y/cli.js', '/x/y/cli.cjs', '/x/y/cli.mjs', 'C:\\claude\\CLI.JS']) {
      assert.deepEqual(
        resolveCommandLaunch(entry, ['-p'], { platform, env: { PATH: makeTempDir() } }),
        { file: process.execPath, args: [entry, '-p'], shell: false },
        `${platform} ${entry}`,
      );
    }
  }
});

test('an explicit shell choice wins over the default', () => {
  const fileExists = fakeFiles('C:\\npm\\codex.cmd');
  const env = { PATH: 'C:\\npm' };
  assert.deepEqual(
    resolveCommandLaunch('taskkill', ['/PID', '9', '/T', '/F'], {
      platform: 'win32',
      shell: false,
    }),
    { file: 'taskkill', args: ['/PID', '9', '/T', '/F'], shell: false },
  );
  assert.deepEqual(
    resolveCommandLaunch('codex', ['app-server'], {
      platform: 'win32',
      env,
      fileExists,
      shell: false,
    }),
    { file: 'codex', args: ['app-server'], shell: false },
  );
  // An explicit cmd.exe still gets one quoted command line, never loose args.
  assert.deepEqual(
    resolveCommandLaunch('claude', ['--version', 'a b'], { platform: 'win32', shell: true }),
    { file: 'claude --version "a b"', args: [], shell: true },
  );
  assert.deepEqual(
    resolveCommandLaunch('codex', ['--version'], { platform: 'win32', shell: 'C:\\bin\\bash.exe' }),
    { file: 'codex', args: ['--version'], shell: 'C:\\bin\\bash.exe' },
  );
});

test('runCommand still spawns a POSIX command directly', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX host only');
    return;
  }
  const result = runCommand(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    '/x',
  ]);
  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '/x');
});
