import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  PROCESS_MARKERS,
  PROCESS_OPS,
  currentProcessStartToken,
  identityVerdict,
  processHasExited,
  processMaybeOurs,
  processStartToken,
  processVerdict,
  readProcessIdentity,
} from '../plugins/stereo/src/platform/process.ts';
import type {
  CommandLineProbe,
  CommandLineProbeResult,
  IdentityVerdict,
  ProcessIdentity,
  ProcessOps,
  ProcessVerdict,
} from '../plugins/stereo/src/platform/process.ts';
import { makeTempDir, ticksOf, waitFor, withTicks } from './helpers.ts';
import { spawnStandIn, stopStandIn } from './runtime-helpers.ts';

// Process identity: the pure verdicts, each platform's identity source (a
// fake procfs tree for Linux, injected probes for macOS and Windows), and
// smoke tests against the real kernel, whose only children are short-lived
// `node` stand-ins and `sleep`s (never claude or codex) stopped when the test
// ends.

const { worker: WORKER, broker: BROKER, claude: CLAUDE } = PROCESS_MARKERS;
const LINUX = process.platform === 'linux';
const WINDOWS = process.platform === 'win32';
// A pid no process has, read only through injected seams.
const PID = 2147483001;
// A recorded start: 2026-09-26 07:00:00 UTC.
const R = Date.UTC(2026, 8, 26, 7, 0, 0);
const BOOT = '0b9e5f3c-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
const OTHER_BOOT = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const WORKER_ARGV = ['/usr/bin/node', '/opt/stereo/scripts/codex-companion.ts', 'task-worker'];
const WORKER_LINE = WORKER_ARGV.join(' ');
const VIM_ARGV = ['/usr/bin/vim', 'notes.txt'];
const alive = (): boolean => false;

function linuxId(ticks: number, boot = BOOT): string {
  return `linux:${boot}:${ticks}`;
}

function wall(ms: number): string {
  return `wall:${ms}`;
}

function identity(fields: Partial<ProcessIdentity>): ProcessIdentity {
  return { commandLine: null, start: null, ...fields };
}

// The process seams for a verdict: a platform, a liveness answer (alive by
// default), and an identity read through `probe` (macOS, Windows) or a fake
// procfs `procRoot` (Linux), unless `readProcessIdentity` replaces it.
function opsFor(
  platform: NodeJS.Platform,
  extra: Partial<ProcessOps> & { probe?: CommandLineProbe; procRoot?: string } = {},
): ProcessOps {
  const { probe, procRoot, ...seams } = extra;
  return {
    ...PROCESS_OPS,
    processHasExited: alive,
    readProcessIdentity: (pid, options) =>
      readProcessIdentity(pid, { ...options, probe, procRoot }),
    ...seams,
    platform,
  };
}

// Sets TZ for the rest of the test (Node re-reads it on assignment).
function useTimeZone(t: TestContext, zone: string): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  });
}

// A macOS or Windows probe that records its calls and answers `result`.
function fakeProbe(result: CommandLineProbeResult | (() => CommandLineProbeResult)) {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const probe = (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): CommandLineProbeResult => {
    calls.push({ command, args, timeoutMs });
    return typeof result === 'function' ? result() : result;
  };
  return { calls, probe };
}

test("this process's start token is read once: sleep and clock steps never move it", (t) => {
  const before = currentProcessStartToken();
  if (LINUX) {
    assert.match(before, /^linux:[^:\s]+:\d+$/);
  } else {
    assert.ok(
      Math.abs(Number(before.slice('wall:'.length)) - (Date.now() - process.uptime() * 1000)) <
        2_000,
      'its wall start (Date.now() - uptime at load)',
    );
  }
  const realUptime = process.uptime.bind(process);
  const realNow = Date.now;
  t.after(() => {
    process.uptime = realUptime;
    Date.now = realNow;
  });
  // An hour of system sleep: the wall clock advanced, process.uptime() did not.
  process.uptime = () => realUptime() - 3600;
  assert.equal(currentProcessStartToken(), before, 'uptime stopped during sleep');
  Date.now = () => realNow() + 3_600_000;
  process.uptime = realUptime;
  assert.equal(currentProcessStartToken(), before, 'the wall clock jumped an hour ahead');
  Date.now = () => realNow() - 3_600_000;
  process.uptime = () => realUptime() - 8 * 3600;
  assert.equal(currentProcessStartToken(), before, 'a long sleep and a step back');
});

// ---------------------------------------------------------------------------
// The verdicts

test('identityVerdict compares Linux tokens exactly and wall starts within their window', () => {
  const id = linuxId(123_456);
  const dash = linuxId(500, '-');
  type Row = [string, Partial<ProcessIdentity> | null, IdentityVerdict];
  const offset = (ms: number, verdict: IdentityVerdict): Row => [
    `a wall start ${ms} ms off`,
    { start: wall(R + ms) },
    verdict,
  ];
  const groups: Array<[string | null | undefined, Row[]]> = [
    // A Linux token: its boot id and ticks; never a wall start in its place.
    [
      id,
      [
        ['equal tokens', { start: id }, 'match'],
        ['equal tokens, another title', { start: id, commandLine: 'vim' }, 'match'],
        ['another tick', { start: linuxId(123_457) }, 'contradicts'],
        ['another boot (a reboot)', { start: linuxId(123_456, OTHER_BOOT) }, 'contradicts'],
        ['a wall start seen', { start: wall(R) }, 'unknown'],
        ['no start seen', {}, 'unknown'],
        ['no identity', null, 'unknown'],
      ],
    ],
    // An unreadable boot id (`-`) is compared as it is.
    [
      dash,
      [
        ['`-`, equal', { start: dash }, 'match'],
        ['`-`, another tick', { start: linuxId(501, '-') }, 'contradicts'],
        ['`-` never equals a real boot id', { start: linuxId(500) }, 'contradicts'],
      ],
    ],
    // A wall start (macOS, Windows): R - 10000 <= L <= R + 2000. A DST hour
    // read in local time is an hour off: it never matches.
    [
      wall(R),
      [
        offset(0, 'match'),
        offset(-10_000, 'match'),
        offset(-10_001, 'contradicts'),
        offset(-7_000, 'match'),
        offset(2_000, 'match'),
        offset(2_001, 'contradicts'),
        offset(4_000, 'contradicts'),
        offset(-3_600_000, 'contradicts'),
        offset(3_600_000, 'contradicts'),
        ['a Linux token seen', { start: id }, 'unknown'],
        ['no start seen', {}, 'unknown'],
        ['no identity', null, 'unknown'],
      ],
    ],
    // Nothing (or nothing readable) recorded to compare.
    [null, [['null', { start: wall(R) }, 'unknown']]],
    [undefined, [['absent', { start: id }, 'unknown']]],
    ['wall:soon', [['a malformed wall start', { start: wall(R) }, 'unknown']]],
    ['12345', [['no kind', { start: wall(R) }, 'unknown']]],
  ];
  for (const [expected, rows] of groups) {
    for (const [label, seen, verdict] of rows) {
      assert.equal(identityVerdict(seen && identity(seen), expected), verdict, label);
    }
  }
});

test('processVerdict adds liveness and the marker rule; only ours or unknown may run', () => {
  // Tokens with no boot id (`-`), so no host reads them as an earlier boot's.
  const id = 'linux:-:1000';
  const worker = { commandLine: WORKER_LINE };
  const vim = { commandLine: 'vim notes.txt' };
  // What the read sees ('exited': the pid is gone), and the verdict.
  type Row = [string, Partial<ProcessIdentity> | null | 'exited', ProcessVerdict];
  const groups: Array<[NodeJS.Platform, string | null, Row[]]> = [
    // Linux: the token decides whatever the title says now.
    [
      'linux',
      id,
      [
        ['an exited pid (a zombie included)', 'exited', 'dead'],
        ['a failed read', null, 'unknown'],
        ['an equal token', { start: id, ...worker }, 'ours'],
        ['the title rewritten', { start: id, commandLine: 'stereo-worker' }, 'ours'],
        ['another token', { start: 'linux:-:1003', ...worker }, 'foreign'],
        ['no token read, the marker matches', worker, 'unknown'],
        ['no token read, another program', vim, 'foreign'],
      ],
    ],
    // Linux never compares a wall start: the marker rule.
    [
      'linux',
      wall(1),
      [
        ['a Linux wall start, the marker matches', { start: id, ...worker }, 'ours'],
        ['a Linux wall start, another program', { start: id, ...vim }, 'foreign'],
      ],
    ],
    // macOS and Windows: a wall start within its window, and the marker.
    [
      'darwin',
      wall(R),
      [
        ['an exited pid', 'exited', 'dead'],
        ['a failed probe', null, 'unknown'],
        ['a start in the window', { ...worker, start: wall(R - 7_000) }, 'ours'],
        [
          'a start past the window (a reused pid)',
          { ...worker, start: wall(R + 60_000) },
          'foreign',
        ],
        ['a start in the window, another program', { ...vim, start: wall(R) }, 'foreign'],
        ['a start not read, the marker matches', worker, 'unknown'],
        ['a start not read, another program', vim, 'foreign'],
      ],
    ],
    // A CODEX_HOME shared between WSL and Windows: no Linux token to compare.
    [
      'win32',
      id,
      [
        ['a Linux record read on Windows', { ...worker, start: wall(R) }, 'unknown'],
        ['a Linux record read on Windows, exited', 'exited', 'dead'],
      ],
    ],
    // A record with no start (written before start tokens): the marker rule.
    [
      'win32',
      null,
      [
        ['no start recorded, the marker matches', { ...worker, start: wall(R) }, 'ours'],
        ['no start recorded, another program', vim, 'foreign'],
        ['no start recorded, no command line', { start: wall(R) }, 'unknown'],
      ],
    ],
  ];
  for (const [platform, expectedStart, rows] of groups) {
    for (const [label, seen, expected] of rows) {
      let reads = 0;
      const options = {
        expectedStart,
        ops: opsFor(platform, {
          processHasExited: () => seen === 'exited',
          readProcessIdentity: () => {
            reads += 1;
            return seen === 'exited' || seen === null ? null : identity(seen);
          },
        }),
      };
      assert.equal(processVerdict(PID, WORKER, options), expected, label);
      assert.equal(reads, seen === 'exited' ? 0 : 1, `${label}: one read for start and marker`);
      assert.equal(
        processMaybeOurs(PID, WORKER, options),
        expected === 'ours' || expected === 'unknown',
        `${label}: possibly alive`,
      );
    }
  }
});

test('any one of several markers counts, an empty list none, and a pid that names no process is dead', () => {
  let reads = 0;
  const options = {
    ops: opsFor('darwin', {
      readProcessIdentity: () => {
        reads += 1;
        return identity({ commandLine: WORKER_LINE });
      },
    }),
  };
  assert.equal(processVerdict(PID, [BROKER, WORKER], options), 'ours');
  assert.equal(processVerdict(PID, [BROKER, CLAUDE], options), 'foreign');
  assert.equal(processVerdict(PID, [], options), 'foreign');
  // The Claude marker is a flag only headless children carry: the user's
  // own interactive session is never taken for one.
  const running = (commandLine: string) => ({
    ops: opsFor('darwin', { readProcessIdentity: () => identity({ commandLine }) }),
  });
  assert.equal(processVerdict(PID, CLAUDE, running('claude --resume abc')), 'foreign');
  assert.equal(
    processVerdict(PID, CLAUDE, running('/usr/bin/claude -p --permission-prompts none')),
    'ours',
  );
  reads = 0;
  for (const pid of [0, -1, 2.5, Number.NaN, null, undefined, 'x']) {
    assert.equal(processVerdict(pid, WORKER, options), 'dead', String(pid));
  }
  assert.equal(reads, 0, 'no identity is read for a pid that names no process');
});

// ---------------------------------------------------------------------------
// The identity sources: macOS, Windows, Linux

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `ps -o lstart=` as TZ=UTC0 LC_ALL=C prints it: `Sun Nov  1 06:30:00 2026`.
function utcLstart(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

test('macOS: one ps run gives the start in UTC and the command line', (t) => {
  const { calls, probe } = fakeProbe({
    status: 0,
    stdout: 'Fri Sep  4 09:05:07 2026 node app-server-broker.ts serve\n',
  });
  assert.deepEqual(readProcessIdentity(77, { platform: 'darwin', probe }), {
    commandLine: 'node app-server-broker.ts serve',
    start: wall(Date.UTC(2026, 8, 4, 9, 5, 7)),
  });
  // Separate -o options: BSD ps reads a header's `=` to the end of its argument.
  assert.deepEqual(calls, [
    {
      command: 'ps',
      args: ['-o', 'lstart=', '-o', 'command=', '-p', '77'],
      timeoutMs: 5000,
    },
  ]);

  // UTC through the DST fall-back hour, whatever the local zone: New York
  // repeats 01:00-02:00 local on 2026-11-01, Sofia 03:00-04:00 on 2026-10-25.
  useTimeZone(t, 'UTC');
  for (const [zone, instants] of [
    ['America/New_York', [Date.UTC(2026, 10, 1, 5, 30, 0), Date.UTC(2026, 10, 1, 6, 30, 0)]],
    ['Europe/Sofia', [Date.UTC(2026, 9, 25, 0, 30, 0), Date.UTC(2026, 9, 25, 1, 30, 0)]],
  ] as const) {
    process.env.TZ = zone;
    for (const instant of instants) {
      const line = fakeProbe({ status: 0, stdout: `${utcLstart(instant)} ${WORKER_LINE}\n` });
      const seen = readProcessIdentity(PID, { platform: 'darwin', probe: line.probe });
      assert.equal(seen?.start, wall(instant), `${zone}: ${utcLstart(instant)}`);
    }
  }

  // Whole seconds: the window still holds at its edges.
  const verdict = (seen: number): ProcessVerdict =>
    processVerdict(PID, WORKER, {
      ops: opsFor('darwin', {
        probe: fakeProbe({ status: 0, stdout: `${utcLstart(seen)} ${WORKER_LINE}\n` }).probe,
      }),
      expectedStart: wall(R),
    });
  assert.deepEqual([R - 10_000, R - 11_000, R + 2_000, R + 3_000].map(verdict), [
    'ours',
    'foreign',
    'ours',
    'foreign',
  ]);

  // A date ps printed in another locale: no start, the whole line kept.
  const localized = fakeProbe({ status: 0, stdout: 'ven. 4 sept. 09:05:07 2026 node x.ts\n' });
  assert.deepEqual(readProcessIdentity(77, { platform: 'darwin', probe: localized.probe }), {
    commandLine: 'ven. 4 sept. 09:05:07 2026 node x.ts',
    start: null,
  });
});

const WINDOWS_IDENTITY_SCRIPT =
  "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = 4321'; " +
  "if ($p) { $t = '-'; try { $t = (Get-Process -Id 4321 -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { }; $t; $p.CommandLine }";

// A start as the Windows probe prints it: a FILETIME (100 ns since 1601, UTC).
function filetime(ms: number, extra100ns = 3000n): string {
  return String((BigInt(ms) + 11_644_473_600_000n) * 10_000n + extra100ns);
}

test('Windows: one PowerShell query gives the start FILETIME and the command line', (t) => {
  const { calls, probe } = fakeProbe({
    status: 0,
    stdout: `${filetime(1790000000123, 0n)}\r\n  "C:\\node.exe" C:\\plugin\\scripts\\codex-companion.ts task  \r\n`,
  });
  assert.deepEqual(readProcessIdentity(4321, { platform: 'win32', probe }), {
    commandLine: '"C:\\node.exe" C:\\plugin\\scripts\\codex-companion.ts task',
    start: wall(1790000000123),
  });
  assert.deepEqual(calls, [
    {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDENTITY_SCRIPT],
      timeoutMs: 5000,
    },
  ]);
  // Nothing in the script needs a double quote the argv quoting would escape.
  assert.doesNotMatch(WINDOWS_IDENTITY_SCRIPT, /"/);

  // The FILETIME converts exactly, with no local time: Sofia repeats 03:00-04:00
  // local (00:00-02:00 UTC) on 2026-10-25.
  useTimeZone(t, 'Europe/Sofia');
  for (const instant of [
    Date.UTC(2026, 9, 25, 0, 30, 0, 123),
    Date.UTC(2026, 9, 25, 1, 30, 0, 123),
    Date.UTC(2026, 2, 29, 0, 59, 59, 999),
  ]) {
    const line = fakeProbe({ status: 0, stdout: `${filetime(instant)}\r\n${WORKER_LINE}\r\n` });
    const seen = readProcessIdentity(PID, { platform: 'win32', probe: line.probe });
    assert.equal(seen?.start, wall(instant), `FILETIME ${filetime(instant)}`);
  }

  // A start the process withholds (`-`): the command line alone, and a
  // recorded start then stays unknown.
  const withheld = fakeProbe({ status: 0, stdout: '-\r\nnode codex-companion.ts task\r\n' });
  assert.deepEqual(readProcessIdentity(4321, { platform: 'win32', probe: withheld.probe }), {
    commandLine: 'node codex-companion.ts task',
    start: null,
  });
  const verdict = (probeResult: CommandLineProbeResult, marker: string) =>
    processVerdict(4321, marker, {
      ops: opsFor('win32', { probe: fakeProbe(probeResult).probe }),
      expectedStart: wall(R),
    });
  assert.equal(verdict({ status: 0, stdout: '-\r\nnode codex-companion.ts' }, WORKER), 'unknown');
  assert.equal(verdict({ status: 0, stdout: '-\r\nnode codex-companion.ts' }, BROKER), 'foreign');
  // A protected process: its start without a command line.
  const hidden = fakeProbe({ status: 0, stdout: `${filetime(R)}\r\n` });
  assert.deepEqual(readProcessIdentity(4321, { platform: 'win32', probe: hidden.probe }), {
    commandLine: null,
    start: wall(R),
  });
  assert.equal(
    processVerdict(4321, WORKER, { ops: opsFor('win32', { probe: hidden.probe }) }),
    'unknown',
  );
});

test('a probe that fails, times out, throws, or prints nothing is unknown, as is a platform without one', () => {
  const outcomes: Array<CommandLineProbeResult | (() => CommandLineProbeResult)> = [
    { status: 1, stdout: 'node codex-companion.ts' },
    { status: null, stdout: 'node codex-companion.ts' },
    {
      status: null,
      stdout: null,
      error: Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    },
    { status: 0, stdout: 'node codex-companion.ts', error: new Error('spawn ETIMEDOUT') },
    { status: 0, stdout: '  \r\n\t' },
    { status: 0, stdout: null },
    () => {
      throw new Error('EAGAIN');
    },
  ];
  for (const platform of ['darwin', 'win32'] as const) {
    for (const [index, outcome] of outcomes.entries()) {
      const { probe } = fakeProbe(outcome);
      assert.equal(readProcessIdentity(55, { platform, probe }), null, `${platform} #${index}`);
      for (const expectedStart of [wall(R), null]) {
        const options = { ops: opsFor(platform, { probe }), expectedStart };
        assert.equal(processVerdict(55, WORKER, options), 'unknown', `${platform} #${index}`);
      }
    }
  }
  const { calls, probe } = fakeProbe({ status: 0, stdout: 'never used' });
  assert.equal(readProcessIdentity(55, { platform: 'aix', probe }), null);
  assert.equal(processVerdict(55, WORKER, { ops: opsFor('aix', { probe }) }), 'unknown');
  assert.deepEqual(calls, []);
});

interface FakeProc {
  ticks: number;
  argv?: readonly string[];
  /** Field 2 of stat; spaces and parentheses inside are legal. */
  comm?: string;
  /** Leave the stat file out (a read that fails). */
  noStat?: boolean;
}

// A fake procfs tree (the procRoot seam): `<root>/<pid>/{cmdline,stat}` and
// the boot id.
function fakeProcTree() {
  const root = makeTempDir('fake-proc-');
  const tree = {
    root,
    write(pid: number, proc: FakeProc): void {
      const dir = path.join(root, String(pid));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const argv = proc.argv ?? WORKER_ARGV;
      fs.writeFileSync(path.join(dir, 'cmdline'), argv.map((arg) => `${arg}\0`).join(''));
      if (!proc.noStat) {
        // Fields 3..21, then field 22: the start ticks.
        const fields = ['S', ...Array.from({ length: 18 }, () => 0), proc.ticks, 0];
        fs.writeFileSync(
          path.join(dir, 'stat'),
          `${pid} (${proc.comm ?? 'node'}) ${fields.join(' ')}\n`,
        );
      }
    },
    remove(pid: number): void {
      fs.rmSync(path.join(root, String(pid)), { recursive: true, force: true });
    },
    setBootId(bootId: string | null): void {
      const file = path.join(root, 'sys', 'kernel', 'random', 'boot_id');
      fs.rmSync(file, { force: true });
      if (bootId !== null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${bootId}\n`);
      }
    },
  };
  tree.setBootId(BOOT);
  return tree;
}

const TARGET = 3_900_002;

// A tree whose boot id cannot be read (`-`): its tokens are never taken for
// an earlier boot's by the host, whose real boot id the verdict compares.
function dashTree() {
  const tree = fakeProcTree();
  tree.setBootId(null);
  return tree;
}

test(
  'Linux: /proc gives the command line and the start token after the last `)` of stat',
  { skip: WINDOWS },
  () => {
    const tree = fakeProcTree();
    const read = (pid: number) =>
      readProcessIdentity(pid, { platform: 'linux', procRoot: tree.root });
    tree.write(TARGET, { ticks: 123_456, comm: 'x) R 9 9 (y 7 8)' });
    // Linux reads no wall start.
    assert.deepEqual(read(TARGET), { commandLine: WORKER_LINE, start: linuxId(123_456) });
    tree.write(TARGET + 2, { ticks: 1, noStat: true });
    assert.equal(read(TARGET + 2)?.start, null, 'no stat, no start token');
    assert.equal(read(TARGET + 7), null, 'no such pid');
    // An unreadable boot id is `-`.
    tree.setBootId(null);
    assert.equal(read(TARGET)?.start, linuxId(123_456, '-'));
  },
);

test(
  'Linux verdicts: the start token decides, and one from an earlier boot is dead unread',
  { skip: WINDOWS },
  () => {
    const tree = dashTree();
    const verdict = (expectedStart: string | null, extra: Partial<ProcessOps> = {}) =>
      processVerdict(TARGET, WORKER, {
        ops: opsFor('linux', { procRoot: tree.root, ...extra }),
        expectedStart,
      });
    tree.write(TARGET, { ticks: 99_000 });
    const recorded = linuxId(99_000, '-');
    assert.equal(verdict(recorded), 'ours');
    // An exact token names the process whatever its title says now.
    tree.write(TARGET, {
      ticks: 99_000,
      comm: 'stereo-worker',
      argv: ['stereo-worker: task job-1'],
    });
    assert.equal(verdict(recorded), 'ours');
    // The pid reused 30 ms later (three ticks): the same wall second, another process.
    tree.write(TARGET, { ticks: 99_003 });
    assert.equal(verdict(recorded), 'foreign');
    // No token recorded: the marker rule, and a wall start is never compared.
    for (const expectedStart of [null, wall(1), wall(Date.now())]) {
      assert.equal(verdict(expectedStart), 'ours', `start ${expectedStart}`);
    }
    tree.write(TARGET, { ticks: 99_003, argv: VIM_ARGV });
    assert.equal(verdict(wall(Date.now())), 'foreign');
    // An unreadable stat: unknown while the marker matches, foreign once it contradicts.
    tree.write(TARGET, { ticks: 99_000, noStat: true });
    assert.equal(verdict(recorded), 'unknown');
    tree.write(TARGET, { ticks: 99_000, noStat: true, argv: VIM_ARGV });
    assert.equal(verdict(recorded), 'foreign');
    // An entry that cannot be read while the pid runs is unknown, never dead.
    tree.remove(TARGET);
    assert.equal(verdict(recorded), 'unknown');
    assert.equal(verdict(recorded, { processHasExited: () => true }), 'dead');
  },
);

test(
  'a Linux start token from an earlier boot is dead before any liveness check or read',
  { skip: !LINUX || !fs.existsSync('/proc/sys/kernel/random/boot_id') },
  () => {
    const hostBoot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const earlierBoot = hostBoot === OTHER_BOOT ? BOOT : OTHER_BOOT;
    const probed: number[] = [];
    const ops = opsFor('linux', {
      processHasExited: (pid) => {
        probed.push(pid);
        return false;
      },
      readProcessIdentity: (pid) => {
        probed.push(pid);
        return identity({ commandLine: WORKER_LINE, start: linuxId(99_000, earlierBoot) });
      },
    });
    assert.equal(
      processVerdict(TARGET, WORKER, { ops, expectedStart: linuxId(99_000, earlierBoot) }),
      'dead',
    );
    assert.deepEqual(probed, [], 'no liveness check or identity read');
    // This boot's token is read as usual.
    const current = linuxId(99_000, hostBoot);
    assert.equal(
      processVerdict(TARGET, WORKER, {
        ops: opsFor('linux', {
          readProcessIdentity: () => identity({ commandLine: WORKER_LINE, start: current }),
        }),
        expectedStart: current,
      }),
      'ours',
    );
  },
);

test('Linux: a zombie (exited, not yet reaped) counts as exited', { skip: !LINUX }, async (t) => {
  // The shell starts a short sleep, prints its pid, and is replaced by a
  // longer sleep before the short one ends: nothing is left to reap it. (A
  // `sleep 0` could end first and be reaped by the shell itself.)
  const parent = spawn('sh', ['-c', 'sleep 0.3 & echo $!; exec sleep 30'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => parent.kill('SIGKILL'));
  const zombiePid = await new Promise<number>((resolve, reject) => {
    parent.stdout.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  await waitFor(() => /\)\s+Z\s/.test(fs.readFileSync(`/proc/${zombiePid}/stat`, 'utf8')), {
    timeoutMs: 10_000,
  });
  // kill(pid, 0) still succeeds for a zombie; the check reads its state.
  assert.doesNotThrow(() => process.kill(zombiePid, 0));
  assert.equal(processHasExited(zombiePid), true);
  assert.equal(processVerdict(zombiePid, 'sleep'), 'dead');
  assert.equal(processHasExited(parent.pid as number), false, 'its live parent runs');
});

test('the host identity source reads this process and a live stand-in, and a stopped one is dead', async (t) => {
  const own = path.basename(process.argv[1] ?? '');
  assert.ok(own, 'the test process runs a script');
  const self = readProcessIdentity(process.pid);
  assert.ok(self, 'this process has an identity');
  assert.ok(self.commandLine?.includes(own), 'its own command line');
  // On Windows every identity read is a PowerShell run of seconds: that one
  // read serves these verdicts, and the stand-in's reads run off Windows only.
  const host = WINDOWS ? { ops: { ...PROCESS_OPS, readProcessIdentity: () => self } } : {};
  assert.equal(processVerdict(process.pid, own, host), 'ours');
  assert.equal(processVerdict(process.pid, ['no-such-token-6f2c1b', own], host), 'ours');
  assert.equal(processVerdict(process.pid, 'no-such-token-6f2c1b', host), 'foreign');
  if (LINUX) {
    const selfToken = currentProcessStartToken();
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    assert.ok(selfToken.startsWith(`linux:${bootId}:`), 'linux:<boot_id>:<ticks>');
    assert.match(selfToken, /^linux:[^:\s]+:\d+$/);
    assert.equal(self.start, selfToken);
    assert.equal(processStartToken(process.pid), selfToken);
  } else {
    assert.ok(
      Math.abs(
        Number(self.start?.slice('wall:'.length)) - (Date.now() - process.uptime() * 1000),
      ) <= 2_000,
      `${self.start} is this process's start`,
    );
    assert.equal(processStartToken(process.pid), null, 'no free start token off Linux');
  }
  if (WINDOWS) {
    return;
  }

  const standIn = spawnStandIn(WORKER);
  t.after(() => stopStandIn(standIn));
  // Its start token was noted as its launcher returned, as a record's is.
  const { pid, start } = standIn;
  await waitFor(() => processVerdict(pid, WORKER, { expectedStart: start }) === 'ours', {
    timeoutMs: 10_000,
  });
  assert.equal(processVerdict(pid, BROKER), 'foreign', 'another program to the marker rule');
  if (LINUX) {
    assert.match(start, /^linux:/);
    assert.equal(readProcessIdentity(pid)?.start, start, 'stable while it lives');
    // A later process on that pid never matches the token read at spawn.
    const later = withTicks(start, ticksOf(start) + 1);
    assert.equal(processVerdict(pid, WORKER, { expectedStart: later }), 'foreign');
  }
  stopStandIn(standIn);
  await waitFor(() => processVerdict(pid, WORKER, { expectedStart: start }) === 'dead', {
    timeoutMs: 10_000,
  });
});

test(
  'the macOS and Windows probes run on the host: ps reads this process in UTC, and no PowerShell is unknown',
  { skip: WINDOWS || spawnSync('ps', ['-p', String(process.pid)]).status !== 0 },
  (t) => {
    // New York is UTC-4 in September: a local-time parse would be 4 h off.
    useTimeZone(t, 'America/New_York');
    const own = path.basename(process.argv[1] ?? '');
    const viaPs = readProcessIdentity(process.pid, { platform: 'darwin' });
    assert.ok(viaPs, 'ps printed this process');
    assert.ok(viaPs.commandLine?.includes(own), 'ps printed the command');
    const ownStart = Math.round(Date.now() - process.uptime() * 1000);
    assert.ok(
      Math.abs(Number(viaPs.start?.slice('wall:'.length)) - ownStart) <= 2_000,
      `ps ${viaPs.start} vs this process's own start ${ownStart}`,
    );
    const darwin = { ops: { ...PROCESS_OPS, platform: 'darwin' as const } };
    assert.equal(processVerdict(process.pid, ['no-such-token-6f2c1b', own], darwin), 'ours');
    assert.equal(processVerdict(process.pid, 'no-such-token-6f2c1b', darwin), 'foreign');
    // ps prints nothing and fails for a pid nobody has: unknown, not foreign.
    assert.equal(processVerdict(2147483647, own, { ops: opsFor('darwin') }), 'unknown');

    // An empty directory as the whole PATH: no powershell.exe to start.
    const previousPath = process.env.PATH;
    process.env.PATH = makeTempDir();
    t.after(() => {
      process.env.PATH = previousPath;
    });
    assert.equal(readProcessIdentity(process.pid, { platform: 'win32' }), null);
    assert.equal(
      processVerdict(process.pid, own, { ops: { ...PROCESS_OPS, platform: 'win32' } }),
      'unknown',
    );
  },
);
