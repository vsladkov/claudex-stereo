import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { errorCode } from '../shared/errors.ts';
import { sleepSync } from '../shared/fs.ts';
import { optionalString, recordedPid } from '../shared/json.ts';

// The epoch ms this process started, taken once at module load: the process
// clock behind process.uptime() stops while the system sleeps, so the same
// subtraction done later in a long-lived process (a worker, the broker) would
// come out late by every sleep since the start.
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);

// The procfs root the Linux identity readers use. Its paths are POSIX paths
// on every host (path.posix): a Windows host that runs these readers still
// reads `/proc/<pid>/stat`.
const DEFAULT_PROC_ROOT = '/proc';

// A start token names which process a pid meant, recorded beside the pid
// wherever a later reader must tell it from an unrelated process that reuses
// the pid. Its holders treat it as opaque; identityVerdict compares two:
// - `linux:<boot_id|->:<starttime ticks>` (Linux) is exact: the ticks count
//   from boot, so neither a wall-clock step nor a sleep moves them, and the
//   boot id scopes them;
// - `wall:<epoch ms>` (macOS, Windows, or a Linux start that could not be
//   read) is compared within a window, and never on Linux.
function wallStart(ms: number | null): string | null {
  return ms === null ? null : `wall:${ms}`;
}

/** Fields 3 (the state) and 22 (starttime, clock ticks since boot) of /proc/<pid>/stat. */
interface LinuxProcStat {
  state: string;
  startTicks: string;
}

// Field 2 is the parenthesized program name, which may itself hold spaces or
// parentheses: the fields resume after the last `)`. Null when the entry is
// gone or malformed.
function readLinuxProcStat(procRoot: string, pidPart: string): LinuxProcStat | null {
  let stat: string;
  try {
    stat = fs.readFileSync(path.posix.join(procRoot, pidPart, 'stat'), 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close === -1) {
    return null;
  }
  // fields[0] is field 3 (the state), so field 22 is fields[19].
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const startTicks = fields[19];
  if (!state || !startTicks || !/^\d+$/.test(startTicks)) {
    return null;
  }
  return { state, startTicks };
}

// The host's boot id, read once: it cannot change while this process runs.
let hostBootId: string | null = null;

// The kernel's id for this boot; `-` when it cannot be read (then compared
// as it is, exactly).
function readLinuxBootId(procRoot: string): string {
  if (procRoot === DEFAULT_PROC_ROOT && hostBootId !== null) {
    return hostBootId;
  }
  let bootId = '-';
  try {
    const text = fs
      .readFileSync(path.posix.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), 'utf8')
      .trim();
    bootId = text && /^[^\s:]+$/.test(text) ? text : '-';
  } catch {
    // Unreadable: `-`.
  }
  if (procRoot === DEFAULT_PROC_ROOT) {
    hostBootId = bootId;
  }
  return bootId;
}

function readLinuxStartToken(procRoot: string, pidPart: string): string | null {
  const stat = readLinuxProcStat(procRoot, pidPart);
  return stat ? `linux:${readLinuxBootId(procRoot)}:${stat.startTicks}` : null;
}

let ownStartToken: string | null = null;

// This process's start token, read once: its Linux one, else its wall start.
export function currentProcessStartToken(): string {
  ownStartToken ??=
    (process.platform === 'linux' ? readLinuxStartToken(DEFAULT_PROC_ROOT, 'self') : null) ??
    `wall:${PROCESS_STARTED_AT_MS}`;
  return ownStartToken;
}

// Another process's Linux start token: null elsewhere, and once it is gone.
export function processStartToken(pid: number): string | null {
  return process.platform === 'linux' && recordedPid(pid) !== null
    ? readLinuxStartToken(DEFAULT_PROC_ROOT, String(pid))
    : null;
}

/** A recorded process: its pid and start token. */
export interface RecordedProcess {
  pid: number;
  start: string;
}

// A child this process just spawned, noted as the spawn returns and before
// this process yields to the event loop: until then the child cannot have
// been reaped, so its pid still names it. Its Linux start token, else the
// wall clock now (the child exists by then, so the start the OS reports for
// it is never later than this). Null for a spawn that gave no pid.
export function spawnedProcessIdentity(pid: number | undefined): RecordedProcess | null {
  const spawned = recordedPid(pid);
  return spawned === null
    ? null
    : { pid: spawned, start: processStartToken(spawned) ?? `wall:${Date.now()}` };
}

// This process as the owner a record names (a running job, a reservation, a
// cleanup claim).
export function currentProcessOwner(): { pid: number; pidStart: string } {
  return { pid: process.pid, pidStart: currentProcessStartToken() };
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  stdio?: 'pipe' | 'ignore' | 'inherit';
  shell?: boolean | string;
  /**
   * Milliseconds before the command is killed outright and reported as timed
   * out (an ETIMEDOUT error); unset waits as long as the command runs.
   */
  timeout?: number;
}

export interface CommandResult {
  command: string;
  args: readonly string[];
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
}

export type RunCommandFn = (
  command: string,
  args?: readonly string[],
  options?: RunCommandOptions,
) => CommandResult;

export type KillFn = (pid: number, signal?: NodeJS.Signals | number) => unknown;

export interface BinaryAvailability {
  available: boolean;
  detail: string;
}

export interface TerminateProcessTreeOptions {
  platform?: NodeJS.Platform;
  runCommandImpl?: RunCommandFn;
  killImpl?: KillFn;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** POSIX only: the signal to deliver (SIGTERM by default; SIGKILL to escalate). */
  signal?: NodeJS.Signals;
  /**
   * POSIX only: signal the process group alone, never the pid itself. For a
   * leader known to have exited, whose pid may already name another process.
   */
  groupOnly?: boolean;
}

// What an identity probe (`ps` on macOS, PowerShell on Windows) reports.
export interface CommandLineProbeResult {
  status: number | null;
  stdout?: string | null;
  error?: unknown;
}

// Runs one identity probe; it must give up (a failed result) after timeoutMs.
export type CommandLineProbe = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => CommandLineProbeResult;

/** How long one identity probe (`ps`, PowerShell) may run. */
const PROCESS_PROBE_TIMEOUT_MS = 5000;
/**
 * The wall-clock window around a recorded start (R) that the start the OS
 * reports (L) must fall in on macOS and Windows: R − 10000 ms ≤ L ≤ R + 2000
 * ms. A recorded start is taken at or after the real one (a spawn returns
 * after the child exists; this process reads its own at module load) and `ps`
 * prints whole seconds rounded down, so L sits at or before R; a pid handed
 * to another process starts later than R by at least the first process's
 * lifetime.
 */
const PROCESS_START_BACKWARD_MS = 10_000;
/** The forward half of the macOS/Windows window (see PROCESS_START_BACKWARD_MS). */
const PROCESS_START_FORWARD_MS = 2000;

// Who a pid is right now: its command line and when it started.
export interface ProcessIdentity {
  /** The command line as one string (Linux: the argv elements joined by spaces), or null. */
  commandLine: string | null;
  /**
   * Its start token: Linux's exact one, a wall start on macOS and Windows;
   * null when the OS did not say.
   */
  start: string | null;
}

export interface ReadProcessIdentityOptions {
  /** Test seam: the platform whose identity source is read (the host's by default). */
  platform?: NodeJS.Platform;
  /** Test seam: runs the macOS/Windows probe in place of a real `ps`/PowerShell spawn. */
  probe?: CommandLineProbe;
  /** Test seam: the procfs root the Linux reader reads (`/proc` by default). */
  procRoot?: string;
}

// Markers for the kinds of process the companion records. The Claude
// marker is a flag only our headless children carry (`--permission-prompts
// none`): the bare program name would also match the user's own interactive
// Claude Code session.
export const PROCESS_MARKERS = {
  broker: 'app-server-broker',
  worker: 'codex-companion',
  claude: '--permission-prompts',
} as const;

function markerList(markers: string | readonly string[]): readonly string[] {
  return typeof markers === 'string' ? [markers] : markers;
}

// A start token taken apart: a Linux one (compared whole) with its boot id,
// or a wall start. Null for anything else.
type ParsedStart = { kind: 'linux'; token: string; bootId: string } | { kind: 'wall'; ms: number };

function parseStart(token: unknown): ParsedStart | null {
  const text = optionalString(token);
  if (text?.startsWith('linux:')) {
    const parts = text.split(':');
    return { kind: 'linux', token: text, bootId: parts.length === 3 ? (parts[1] as string) : '-' };
  }
  const wall = text === null ? null : /^wall:(\d+)$/.exec(text);
  return wall ? { kind: 'wall', ms: Number(wall[1]) } : null;
}

// Whether a recorded Linux start token names a process of an earlier boot
// (its boot id differs from this one's): such a pid is dead, whatever runs
// on it now. A boot id that cannot be read, on either side, proves nothing.
function startFromEarlierBoot(recorded: ParsedStart | null): boolean {
  if (recorded?.kind !== 'linux' || recorded.bootId === '' || recorded.bootId === '-') {
    return false;
  }
  const current = readLinuxBootId(DEFAULT_PROC_ROOT);
  return current !== '-' && current !== recorded.bootId;
}

/** How an identity read compares with what was recorded for the pid. */
export type IdentityVerdict = 'match' | 'contradicts' | 'unknown';

// The one comparison of two starts (pure):
// - Linux tokens: exact equality (a different boot id contradicts);
// - wall starts: R − PROCESS_START_BACKWARD_MS ≤ L ≤ R + PROCESS_START_FORWARD_MS;
// - anything missing, or starts of different kinds: 'unknown' (a wall start
//   is never compared with a Linux token: a clock step moves it).
function compareStarts(
  observed: ParsedStart | null,
  recorded: ParsedStart | null,
): IdentityVerdict {
  if (recorded?.kind === 'linux' && observed?.kind === 'linux') {
    return observed.token === recorded.token ? 'match' : 'contradicts';
  }
  if (recorded?.kind === 'wall' && observed?.kind === 'wall') {
    return observed.ms >= recorded.ms - PROCESS_START_BACKWARD_MS &&
      observed.ms <= recorded.ms + PROCESS_START_FORWARD_MS
      ? 'match'
      : 'contradicts';
  }
  return 'unknown';
}

// An identity's start against the recorded start token.
export function identityVerdict(
  identity: ProcessIdentity | null | undefined,
  expectedStart: string | null | undefined,
): IdentityVerdict {
  return compareStarts(parseStart(identity?.start), parseStart(expectedStart));
}

// Whether a record naming this very process's pid names this process (true)
// or an earlier one that had the same pid (false): its own start, no probe.
export function recordNamesThisProcess(expectedStart: string | null): boolean {
  const self: ProcessIdentity = { commandLine: null, start: currentProcessStartToken() };
  return identityVerdict(self, expectedStart) !== 'contradicts';
}

// The marker rule over one identity read: null when the command line is
// unknown, else whether any marker is on it.
function commandLineMatches(
  identity: ProcessIdentity | null,
  markers: string | readonly string[],
): boolean | null {
  const commandLine = identity?.commandLine ?? null;
  return commandLine === null
    ? null
    : markerList(markers).some((marker) => commandLine.includes(marker));
}

// Who a pid is, from one read: Linux reads /proc (argv, and the start ticks
// from the pid's stat); macOS runs one `ps` for the start time and the
// command; Windows runs one PowerShell query for the start time and the
// command line. Null when the pid cannot name a process, the platform has no
// source, or the probe failed or printed nothing; a field the source did not
// give is null.
export function readProcessIdentity(
  pid: number,
  options: ReadProcessIdentityOptions = {},
): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') {
    return readLinuxIdentity(pid, options.procRoot ?? DEFAULT_PROC_ROOT);
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    return null;
  }
  const probe = options.probe ?? spawnCommandLineProbe;
  if (platform === 'darwin') {
    // Separate -o options: BSD ps reads everything after a header's `=` as
    // that header, commas included.
    const output = runIdentityProbe(probe, 'ps', [
      '-o',
      'lstart=',
      '-o',
      'command=',
      '-p',
      String(pid),
    ]);
    return output === null ? null : parsePsIdentity(output);
  }
  const output = runIdentityProbe(probe, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsIdentityScript(pid),
  ]);
  return output === null ? null : parseWindowsIdentity(output);
}

// /proc/<pid>/cmdline is NUL-separated (a zombie's is empty); the stat read
// gives the start ticks behind the start token. No wall start is read: Linux
// compares its own tokens only.
function readLinuxIdentity(pid: number, procRoot: string): ProcessIdentity | null {
  let argv: string[];
  try {
    argv = fs.readFileSync(path.posix.join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0');
  } catch {
    return null;
  }
  // Every element ends in a NUL, the last one included.
  if (argv.at(-1) === '') {
    argv.pop();
  }
  return { commandLine: argv.join(' '), start: readLinuxStartToken(procRoot, String(pid)) };
}

const PS_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
// `ps -o lstart` in the C locale under TZ=UTC0: `Thu Sep 25 10:11:12 2026`,
// in UTC (no repeated or skipped local hour).
const PS_LSTART =
  /^([A-Za-z]{3}) +([A-Za-z]{3}) +(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2}) (\d{4})(?:\s+|$)/;

// One `ps -o lstart= -o command=` line: the start date, then the command.
// A date in another shape (a locale ps did not honour) leaves the start time
// unknown and the whole line as the command line, which still carries it.
function parsePsIdentity(output: string): ProcessIdentity {
  const match = PS_LSTART.exec(output);
  if (!match) {
    return { commandLine: output, start: null };
  }
  const month = PS_MONTHS.indexOf(match[2] as (typeof PS_MONTHS)[number]);
  const started = Date.UTC(
    Number(match[7]),
    month,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  const command = output.slice(match[0].length).trim();
  return {
    commandLine: command || null,
    start: wallStart(month === -1 || !Number.isFinite(started) ? null : started),
  };
}

// The start time as a FILETIME (100 ns intervals since 1601-01-01 UTC, exact
// and free of any local-time ambiguity; `-` when the process withholds it) on
// the first line, the command line (CIM) after it. Single quotes only:
// nothing in them is special to the C runtime's argv parser, so the script
// survives the spawn intact.
function windowsIdentityScript(pid: number): string {
  return (
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    `if ($p) { $t = '-'; try { $t = (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { }; $t; $p.CommandLine }`
  );
}

const FILETIME_TICKS_PER_MS = 10_000n;
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n;

// A FILETIME as epoch ms: ft / 10000 − 11644473600000.
function fileTimeToEpochMs(text: string): number | null {
  const epochMs = Number(BigInt(text) / FILETIME_TICKS_PER_MS - FILETIME_UNIX_EPOCH_MS);
  return Number.isSafeInteger(epochMs) && epochMs > 0 ? epochMs : null;
}

function parseWindowsIdentity(output: string): ProcessIdentity {
  const lineEnd = output.search(/\r?\n/);
  const first = (lineEnd === -1 ? output : output.slice(0, lineEnd)).trim();
  if (!/^(?:\d+|-)$/.test(first)) {
    // Not the shape the query prints: at most a command line.
    return { commandLine: output, start: null };
  }
  const rest = lineEnd === -1 ? '' : output.slice(lineEnd).trim();
  return {
    commandLine: rest || null,
    start: wallStart(first === '-' ? null : fileTimeToEpochMs(first)),
  };
}

// The real probe. The C locale keeps `ps -o lstart` in the one shape parsed
// above, and TZ=UTC0 prints it in UTC.
function spawnCommandLineProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): CommandLineProbeResult {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', ...(command === 'ps' ? { TZ: 'UTC0' } : {}) },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

// What a probe printed, trimmed, or null when it failed or printed nothing
// (a pid nobody has, a process the caller may not inspect).
function runIdentityProbe(
  probe: CommandLineProbe,
  command: string,
  args: readonly string[],
): string | null {
  try {
    const result = probe(command, args, PROCESS_PROBE_TIMEOUT_MS);
    if (result.error || result.status !== 0) {
      return null;
    }
    const output = (result.stdout ?? '').trim();
    return output ? output : null;
  } catch {
    return null;
  }
}

// The process seams every liveness, identity, and signal decision goes
// through: tests replace them as one object.
export interface ProcessOps {
  processHasExited: (pid: number) => boolean;
  /** Whether the process group a pid leads still has a member (POSIX). */
  groupHasMembers: (pid: number) => boolean;
  readProcessIdentity: (
    pid: number,
    options?: ReadProcessIdentityOptions,
  ) => ProcessIdentity | null;
  /** Delivers a signal (terminateProcessTree). */
  terminate: (pid: number, options?: TerminateProcessTreeOptions) => void;
  /** The platform whose identity source and signals apply. */
  platform: NodeJS.Platform;
}

// Only a delivered probe says a group has a member.
function groupHasMembers(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const PROCESS_OPS: ProcessOps = {
  processHasExited: (pid) => processHasExited(pid),
  groupHasMembers,
  readProcessIdentity,
  terminate: terminateProcessTree,
  // Read at each use, like every other platform check here.
  get platform() {
    return process.platform;
  },
};

export interface ProcessVerdictOptions {
  /** The process seams (the host's by default). */
  ops?: ProcessOps;
  /** The recorded process's start token; null or absent: none recorded. */
  expectedStart?: string | null;
}

/**
 * What a recorded pid is now: `dead` (exited, or a zombie), `foreign` (a
 * reused pid: another start, or a program the marker rules out), `ours` (the
 * recorded process), or `unknown` (alive, but its identity could not be
 * checked: a failed or timed-out probe, a recorded start with no start to
 * compare it to).
 */
export type ProcessVerdict = 'dead' | 'foreign' | 'ours' | 'unknown';

// Liveness plus identity, in one verdict. A Linux start token recorded in an
// earlier boot is dead before any check. Then: exited or a zombie → dead; the
// identity contradicts the recorded start → foreign; it matches → ours (an
// exact Linux token whatever the command line says now; a wall start within
// its window unless the marker contradicts it). With no start to compare, the
// marker rule: a contradicting command line → foreign; a matching one → ours
// only for a record that recorded no start at all (on Linux, any record
// without a Linux token), else unknown; no command line → unknown.
//
// Call sites (every caller of a recorded pid's identity goes through here):
// - signalling needs 'ours': stopJobProcesses (cancel, session end), which
//   also counts a signalled process as stopped only once its verdict is
//   'dead' or 'foreign';
// - liveness and takeover checks treat 'unknown' as alive (processMaybeOurs):
//   reservations pidIsAlive and liveClaudeChild;
// - the cheap rule (recordedProcessGone) reads only the free Linux /proc verdict.
export function processVerdict(
  pid: unknown,
  marker: string | readonly string[] | null,
  options: ProcessVerdictOptions = {},
): ProcessVerdict {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return 'dead';
  }
  const target = pid as number;
  const ops = options.ops ?? PROCESS_OPS;
  const linux = ops.platform === 'linux';
  const parsed = parseStart(options.expectedStart);
  // Linux compares its own tokens only: a recorded wall start is never compared there.
  const recorded = linux && parsed?.kind === 'wall' ? null : parsed;
  if (linux && startFromEarlierBoot(recorded)) {
    return 'dead';
  }
  if (ops.processHasExited(target)) {
    return 'dead';
  }
  const identity = ops.readProcessIdentity(target, { platform: ops.platform });
  if (identity === null) {
    // Gone between the liveness check and the read, or not readable at all.
    return ops.processHasExited(target) ? 'dead' : 'unknown';
  }
  const verdict = compareStarts(parseStart(identity.start), recorded);
  if (verdict === 'contradicts') {
    return 'foreign';
  }
  const markerMatch = marker === null ? null : commandLineMatches(identity, marker);
  if (verdict === 'match') {
    // An exact Linux token names the process whatever its title says now (a
    // process may rewrite it); a wall start within its window still needs the
    // command line not to contradict it.
    return recorded?.kind === 'linux' || markerMatch !== false ? 'ours' : 'foreign';
  }
  if (markerMatch === false) {
    return 'foreign';
  }
  if (recorded !== null) {
    return 'unknown';
  }
  return markerMatch === true ? 'ours' : 'unknown';
}

// The liveness decision (a lock, reservation, or claim holder): a pid that
// may still be the recorded process counts as alive, so a live holder is
// never taken over just because it could not be verified.
export function processMaybeOurs(
  pid: unknown,
  marker: string | readonly string[] | null,
  options: ProcessVerdictOptions = {},
): boolean {
  const verdict = processVerdict(pid, marker, options);
  return verdict === 'ours' || verdict === 'unknown';
}

// Whether a recorded process no longer runs, by the cheap rule status,
// `status --wait`, doctor, and the stranded-reservation scan share: its pid
// is gone (kill(pid, 0) says ESRCH, on Windows too; a Linux zombie), or on
// Linux its recorded start token contradicts /proc (another process on the
// pid, or an earlier boot's). No ps or PowerShell probe runs: a live pid that
// cannot be told apart counts as the recorded process. A record with no pid
// has nothing to judge: not gone.
export function recordedProcessGone(
  pid: unknown,
  start: unknown,
  ops: ProcessOps = PROCESS_OPS,
): boolean {
  const recorded = recordedPid(pid);
  if (recorded === null) {
    return false;
  }
  if (ops.processHasExited(recorded)) {
    return true;
  }
  if (ops.platform !== 'linux' || parseStart(start)?.kind !== 'linux') {
    return false;
  }
  const verdict = processVerdict(recorded, null, { ops, expectedStart: optionalString(start) });
  return verdict === 'dead' || verdict === 'foreign';
}

// A child this process holds the handle of: the only kind of target the
// polite-then-hard escalation signals.
export interface EscalationTarget {
  pid: number;
  /**
   * Whether the pid itself still runs. The holder of the child's handle
   * knows: once a child has exited, its pid may already name an unrelated
   * process.
   */
  isRunning: () => boolean;
}

// A spawned child as an escalation target (null until it has a pid): its
// handle says whether it still runs.
export function childTarget(child: {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}): EscalationTarget | null {
  return typeof child.pid === 'number'
    ? { pid: child.pid, isRunning: () => child.exitCode === null && child.signalCode === null }
    : null;
}

export interface SignalProcessGroupOptions {
  /** Test seam: the platform to signal for (the host's by default). */
  platform?: NodeJS.Platform;
  /** Test seam: delivers each signal (terminateProcessTree by default). */
  terminate?: ProcessOps['terminate'];
}

// One signal to a process and whatever it started. POSIX: the group the pid
// leads gets it even after the leader exited (a member still running keeps
// the group, and any pipe it holds, alive), and while the pid itself runs
// but leads no group (a foreground companion, a child that is not detached)
// the pid gets it directly. Windows has only the tree kill (taskkill /T /F,
// forceful whatever was asked), which needs a live root: an exited root's
// pid may already name an unrelated process. Signal targets (the invariant
// every caller keeps): a group is signalled while its leader is verdict
// 'ours' (or a child whose handle this process holds), or after the leader
// died while the group still has a member (the group-only signal fails with
// ESRCH otherwise). Best effort: a failed signal (already gone, not ours to
// signal) is dropped.
export function signalProcessGroup(
  target: EscalationTarget,
  signal: NodeJS.Signals,
  options: SignalProcessGroupOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const terminate = options.terminate ?? terminateProcessTree;
  try {
    if (target.isRunning()) {
      terminate(target.pid, { platform, signal });
    } else if (platform !== 'win32') {
      terminate(target.pid, { platform, signal, groupOnly: true });
    }
  } catch {
    // Already gone, or not ours to signal.
  }
}

export interface EscalationOptions extends SignalProcessGroupOptions {
  /** How long the polite signal gets before the hard one. */
  graceMs: number;
  /**
   * `sync` waits the grace out in place: a signal handler re-raises its
   * signal as soon as it returns, so a timer would never fire. `timer`
   * escalates from an unref'd timer and returns at once.
   */
  wait: 'sync' | 'timer';
  /** Asked once the grace has passed: false skips the hard signal (the targets settled). */
  stillNeeded?: () => boolean;
}

// The polite signal now and the hard one after the grace, each through
// signalProcessGroup (so on POSIX the hard one still reaches a group whose
// leader obeyed and exited), to every target even when one fails. Windows'
// tree kill is already forceful: nothing is escalated there.
export function signalThenEscalate(
  targets: EscalationTarget | readonly EscalationTarget[],
  options: EscalationOptions,
): void {
  const list: readonly EscalationTarget[] = 'pid' in targets ? [targets] : targets;
  const signalAll = (signal: NodeJS.Signals): void => {
    for (const target of list) {
      signalProcessGroup(target, signal, options);
    }
  };
  signalAll('SIGTERM');
  if (list.length === 0 || (options.platform ?? process.platform) === 'win32') {
    return;
  }
  const escalate = (): void => {
    if (options.stillNeeded?.() !== false) {
      signalAll('SIGKILL');
    }
  };
  if (options.wait === 'sync') {
    sleepSync(options.graceMs);
    escalate();
  } else {
    setTimeout(escalate, options.graceMs).unref?.();
  }
}

// Whether a pid no longer runs: kill(pid, 0) says ESRCH (on Windows too), or
// on Linux it is a zombie (state Z or X: exited, only waiting to be reaped).
// A pid this process may not signal (EPERM) still runs.
export function processHasExited(pid: number, options: { killImpl?: KillFn } = {}): boolean {
  if (!Number.isFinite(pid)) {
    return false;
  }
  const killImpl = options.killImpl ?? (process.kill.bind(process) as KillFn);
  try {
    killImpl(pid, 0);
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
  if (process.platform !== 'linux') {
    return false;
  }
  const stat = readLinuxProcStat(DEFAULT_PROC_ROOT, String(pid));
  return stat !== null && (stat.state === 'Z' || stat.state === 'X');
}

// A `.cmd`/`.bat` file is a batch script: CreateProcess cannot start one,
// only cmd.exe can.
export function isBatchScript(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

// Windows fallback only: a batch shim needs cmd.exe, which gets one command
// line, so every argument is quoted for the C runtime's parser.
export function quoteForCmd(argument: string): string {
  if (/^[A-Za-z0-9_\-.:\\/=@]+$/.test(argument)) {
    return argument;
  }
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// What no quoting carries through cmd.exe into a batch shim, or null. cmd
// reads the line with rules of its own: `%VAR%` expands even inside quotes
// (there is no escape on a command line), a line break ends the command, and
// every `"` toggles its quote state (a `\"` the C runtime keeps literal still
// toggles it), which leaves `& | < > ^` outside a quoted span. A `^` escape
// would not help: the shim re-parses its arguments through `%*`, after the
// first parse consumed the escapes. So an operator is refused wherever cmd's
// quote state is off balance around it: inside an argument that carries a
// quote, or after arguments whose quotes left the state open.
function cmdUnsafeReason(argument: string, openQuote: boolean): string | null {
  if (/[\r\n]/.test(argument)) {
    return 'a line break, which ends the cmd.exe command line';
  }
  if (argument.includes('%')) {
    return 'a %, which cmd.exe expands as a variable reference';
  }
  if (/[&|<>^]/.test(argument) && (openQuote || argument.includes('"'))) {
    return 'one of & | < > ^ next to a double quote, which the shim would run as a shell operator';
  }
  return null;
}

// The whole command line for cmd.exe: every argument quoted for the C
// runtime, after refusing (by name) any argument cmd would expand or split.
export function buildCmdCommandLine(parts: readonly string[]): string {
  let quotes = 0;
  for (const part of parts) {
    const reason = cmdUnsafeReason(part, quotes % 2 === 1);
    if (reason) {
      const shown = part.length > 120 ? `${part.slice(0, 117)}...` : part;
      throw new Error(
        `Refusing to pass the argument ${JSON.stringify(shown)} through cmd.exe to a Windows batch shim: it contains ${reason}. Install the program's native executable (or make its JavaScript entry reachable) so no shell is needed.`,
      );
    }
    quotes += part.split('"').length - 1;
  }
  return parts.map(quoteForCmd).join(' ');
}

export interface CommandLaunch {
  file: string;
  args: string[];
  shell: boolean | string;
}

export interface ResolveCommandLaunchOptions {
  /** An explicit choice wins; unset, see resolveCommandLaunch. */
  shell?: boolean | string;
  /** Whose PATH a bare Windows command name is looked up on (process.env by default). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the platform to resolve for (the host's by default). */
  platform?: NodeJS.Platform;
  /** Test seam: whether a PATH candidate or a shim's script exists as a file. */
  fileExists?: (file: string) => boolean;
  /** Test seam: a batch shim's text, or null when it cannot be read. */
  readFile?: (file: string) => string | null;
}

// A JavaScript entry, which is not executable by itself on any platform.
const SCRIPT_ENTRY = /\.(c|m)?js$/i;

// How a command is spawned. No shell by default: on Windows the user's SHELL
// is often Git Bash, whose MSYS path conversion rewrites switch arguments
// such as `/PID`, and Node warns (DEP0190) whenever arguments travel
// alongside a shell. A JavaScript entry named directly runs under this Node.
// A Windows batch shim (an npm-installed `codex.cmd` or `claude.cmd`, named
// directly or the only form a bare name resolves to) re-parses every argument
// through cmd.exe (`%*`), which no quoting survives for JSON: a shim that
// hands its arguments to a script under Node has that script run under this
// Node instead, with no shell. Any other shim (`npm.cmd`, `code.cmd`) gets
// cmd.exe with the whole command line quoted here, so no argument reaches cmd
// unquoted and none is passed beside the shell; an argument cmd cannot carry
// intact throws (see buildCmdCommandLine).
export function resolveCommandLaunch(
  command: string,
  args: readonly string[] = [],
  options: ResolveCommandLaunchOptions = {},
): CommandLaunch {
  const platform = options.platform ?? process.platform;
  let shell = options.shell;
  if (shell === undefined) {
    if (SCRIPT_ENTRY.test(command)) {
      return { file: process.execPath, args: [command, ...args], shell: false };
    }
    const shim = platform === 'win32' ? findBatchShim(command, options) : null;
    const script = shim === null ? null : batchShimScript(shim, options);
    if (script !== null) {
      return { file: process.execPath, args: [script, ...args], shell: false };
    }
    shell = shim !== null;
  }
  if (platform === 'win32' && shell === true) {
    return { file: buildCmdCommandLine([command, ...args]), args: [], shell: true };
  }
  return { file: command, args: [...args], shell };
}

// The batch shim a Windows command runs as, or null for none: a `.cmd`/`.bat`
// path is one itself, and a path or a name with any other extension is
// spawned as given. A shell-less spawn finds `<name>.com`/`<name>.exe` in any
// PATH directory, so a bare name runs as a shim only when none exists but a
// `<name>.cmd`/`<name>.bat` does (the first on PATH). A name found nowhere
// spawns without a shell and fails as ENOENT.
function findBatchShim(command: string, options: ResolveCommandLaunchOptions): string | null {
  if (isBatchScript(command)) {
    return command;
  }
  if (/[\\/]/.test(command) || path.win32.extname(command) !== '') {
    return null;
  }
  const fileExists = options.fileExists ?? isFile;
  let shim: string | null = null;
  for (const dir of windowsPathEntries(options.env ?? process.env)) {
    if (['.com', '.exe'].some((ext) => fileExists(path.win32.join(dir, `${command}${ext}`)))) {
      return null;
    }
    shim ??=
      ['.cmd', '.bat']
        .map((ext) => path.win32.join(dir, `${command}${ext}`))
        .find((candidate) => fileExists(candidate)) ?? null;
  }
  return shim;
}

// The script a Windows batch shim runs under Node, or null.
function batchShimScript(shim: string, options: ResolveCommandLaunchOptions): string | null {
  const content = (options.readFile ?? readTextFile)(shim);
  return content === null
    ? null
    : parseCmdShimTarget(content, path.win32.dirname(shim), {
        platform: 'win32',
        fileExists: options.fileExists,
      });
}

// `<node> "<script>" %*`: the line of an npm-style shim that hands its
// arguments to a script under Node, where <node> is `node`, a quoted path to
// `node.exe`, or npm's `"%_prog%"` (which names one of those). A shim that
// runs its script under another program (VS Code's `code.cmd` runs its
// cli.js under Code.exe) or through variables (`npm.cmd`) has no such line.
const SHIM_NODE_LINE =
  /(?:"%_prog%"|"[^"\r\n]*\bnode(?:\.exe)?"|\bnode(?:\.exe)?)[ \t]+"([^"\r\n]+)"[ \t]+%\*/gi;

export interface ParseCmdShimTargetOptions {
  /** Whose path rules join the shim's directory (the host's by default). */
  platform?: NodeJS.Platform;
  /** Test seam: whether a script exists as a file. */
  fileExists?: (file: string) => boolean;
}

// The script an npm-style shim runs under Node: a `%~dp0…`/`%dp0%…`
// reference (relative to the shim's directory) or an explicit path, provided
// it exists. An executable never qualifies (a shim may name one where a
// script belongs); an extensionless entry (a plain script) does.
export function parseCmdShimTarget(
  content: string,
  shimDir: string,
  options: ParseCmdShimTargetOptions = {},
): string | null {
  const pathApi = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  const fileExists = options.fileExists ?? isFile;
  for (const match of content.matchAll(SHIM_NODE_LINE)) {
    const reference = match[1] as string;
    const relative = /^%(?:~dp0|dp0%)(.*)$/i.exec(reference);
    // The shim writes Windows separators; they are joined per platform.
    const script = relative
      ? pathApi.join(shimDir, ...(relative[1] as string).split(/[\\/]+/).filter(Boolean))
      : reference.includes('%')
        ? null
        : reference;
    if (script && !/\.(exe|cmd|bat|com)$/i.test(script) && fileExists(script)) {
      return script;
    }
  }
  return null;
}

// Windows environment names are case-insensitive, but a copied env object
// keeps whichever spelling (`Path`, `PATH`) the system used.
function windowsPathEntries(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return (key ? (env[key] ?? '') : '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// How long a probe (a version or login check) may run before it counts as
// failed: a hung binary must not hang setup or a launch with it.
export const PROBE_TIMEOUT_MS = 15_000;

export function runCommand(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): CommandResult {
  let launch: CommandLaunch;
  try {
    launch = resolveCommandLaunch(command, args, { shell: options.shell, env: options.env });
  } catch (error) {
    // A command line cmd.exe cannot carry intact never runs.
    return {
      command,
      args,
      status: 1,
      signal: null,
      stdout: '',
      stderr: '',
      error: error as NodeJS.ErrnoException,
    };
  }
  const timeout = options.timeout && options.timeout > 0 ? options.timeout : undefined;
  const result = spawnSync(launch.file, launch.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? 'pipe',
    shell: launch.shell,
    windowsHide: true,
    // spawnSync waits for the child to exit after its kill signal, so a
    // polite one the child ignores would block the caller all the same.
    ...(timeout ? { timeout, killSignal: 'SIGKILL' as const } : {}),
  });
  const error = (result.error as NodeJS.ErrnoException | undefined) ?? null;
  if (timeout && error?.code === 'ETIMEDOUT') {
    error.message = `${[command, ...args].join(' ')} timed out after ${timeout} ms`;
  }

  return {
    command,
    args,
    // A child a signal ended has no exit status: that is a failure, never 0.
    status: result.status ?? (result.signal ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error,
  };
}

export function runCommandChecked(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): CommandResult {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

// What a probe's answer says: not found, how it failed, or what it printed.
export function availabilityOf(result: CommandResult): BinaryAvailability {
  if (result.error?.code === 'ENOENT') {
    return { available: false, detail: 'not found' };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || 'ok' };
}

// A probe run: bounded by PROBE_TIMEOUT_MS unless the caller names a timeout.
export function binaryAvailable(
  command: string,
  versionArgs: readonly string[] = ['--version'],
  options: RunCommandOptions = {},
): BinaryAvailability {
  return availabilityOf(
    runCommand(command, versionArgs, { timeout: PROBE_TIMEOUT_MS, ...options }),
  );
}

// Signals a process and whatever it started: its process group, else the pid
// itself (POSIX), or its tree (Windows). A target that is already gone is
// nothing to signal; any other failure throws.
export function terminateProcessTree(pid: number, options: TerminateProcessTreeOptions = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? (process.kill.bind(process) as KillFn);

  if (platform === 'win32') {
    // taskkill.exe is a real executable: no shell, so a Git Bash SHELL can
    // never rewrite the /PID and /F switches as paths.
    const result = runCommandImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      cwd: options.cwd,
      env: options.env,
    });

    if (!result.error && result.status === 0) {
      return;
    }

    if (result.error?.code === 'ENOENT') {
      try {
        killImpl(pid);
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') {
          throw error;
        }
      }
      return;
    }

    if (result.error) {
      throw result.error;
    }

    // taskkill failed: whether the pid is gone decides, never its message
    // (localized, and worded differently across Windows versions).
    if (processHasExited(pid, { killImpl })) {
      return;
    }
    throw new Error(formatCommandFailure(result));
  }

  const signal = options.signal ?? 'SIGTERM';
  try {
    killImpl(-pid, signal);
  } catch (error) {
    if (options.groupOnly) {
      // ESRCH: the group is empty, and its leader's pid is left alone.
      if (errorCode(error) === 'ESRCH') {
        return;
      }
      throw error;
    }
    // No group led by this pid (a foreground companion, a child that is not
    // a leader) or no permission: the process itself may still be alive.
    // Every caller has just found the pid verdict 'ours', or holds its handle.
    try {
      killImpl(pid, signal);
    } catch (innerError) {
      if (errorCode(innerError) !== 'ESRCH') {
        throw innerError;
      }
    }
  }
}

export function formatCommandFailure(result: CommandResult): string {
  const parts = [`${result.command} ${result.args.join(' ')}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || '').trim();
  const stdout = (result.stdout || '').trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(': ');
}
