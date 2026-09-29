import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  cleanupSessionJobs,
  handleSessionEnd,
} from '../plugins/stereo/src/hooks/session-lifecycle.ts';
import type { ProcessIdentity, ProcessOps } from '../plugins/stereo/src/platform/process.ts';
import {
  readJobFile,
  resolveJobFile,
  resolveStateFile,
} from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';
import {
  readSessionWorkspaces,
  recordSessionWorkspace,
} from '../plugins/stereo/src/workspace/session-registry.ts';
import { resolveWorkspaceRoot } from '../plugins/stereo/src/workspace/workspace.ts';
import { indexed, makeTempDir, processOps, seedJob, useTempCodexHome } from './helpers.ts';

// The session-end sweep, in process. Every pid here is synthetic and every
// process probe a fake: nothing is spawned or signalled, and no broker is
// involved (no broker record, no endpoint in the environment).

const WORKER_PID = 2147483001;
const CLAUDE_PID = 2147483002;

// Every synthetic pid runs a command line carrying both the worker's and the
// Claude child's marker, with no start: ours by the marker rule.
function oursIdentity(): ProcessIdentity {
  return {
    commandLine: 'node /plugin/scripts/codex-companion.ts claude -p --permission-prompts none',
    start: null,
  };
}

// Probes that answer like live companion processes until they are signalled,
// as Linux seams unless `overrides` says otherwise.
function fakeProcesses(overrides: Partial<ProcessOps> = {}): {
  ops: ProcessOps;
  signalled: Array<[number, string]>;
} {
  const signalled: Array<[number, string]> = [];
  const gone = new Set<number>();
  return {
    signalled,
    ops: processOps({
      terminate: (pid, options) => {
        signalled.push([pid, options?.signal ?? 'SIGTERM']);
        gone.add(pid);
      },
      processHasExited: (pid) => gone.has(pid),
      readProcessIdentity: oursIdentity,
      platform: 'linux',
      ...overrides,
    }),
  };
}

function runningJob(id: string, sessionId: string): JobRecord {
  return {
    id,
    status: 'running',
    title: 'Claude Task',
    runtime: 'claude',
    sessionId,
    pid: WORKER_PID,
    claudePid: CLAUDE_PID,
    createdAt: '2026-09-25T08:00:00.000Z',
    updatedAt: '2026-09-25T08:01:00.000Z',
  };
}

test('SessionEnd sweeps every registered root, then deletes the registry', async (t) => {
  useTempCodexHome(t);
  const sessionId = 'sess-roots';
  const own = makeTempDir();
  const done = resolveWorkspaceRoot(makeTempDir());
  const other = resolveWorkspaceRoot(makeTempDir());
  seedJob(done, { ...runningJob('task-done', sessionId), status: 'completed', pid: null });
  seedJob(other, { ...runningJob('task-other', sessionId), status: 'queued', pid: null });
  recordSessionWorkspace(sessionId, done);
  recordSessionWorkspace(sessionId, other);

  await handleSessionEnd(
    { hook_event_name: 'SessionEnd', session_id: sessionId, cwd: own },
    { ops: fakeProcesses().ops },
  );
  assert.deepEqual(readSessionWorkspaces(sessionId), []);
  assert.equal(indexed(done, 'task-done')?.status, 'completed', 'a finished job keeps its row');
  assert.equal(indexed(other, 'task-other'), undefined, 'the swept job leaves the index');
});

test('the registry goes with the sweep even when a root could not be swept', async (t) => {
  useTempCodexHome(t);
  const sessionId = 'sess-sweep-failures';
  const own = resolveWorkspaceRoot(makeTempDir());
  const unreadable = resolveWorkspaceRoot(makeTempDir());
  seedJob(own, { ...runningJob('task-own', sessionId), status: 'queued', pid: null });
  seedJob(unreadable, { ...runningJob('task-other', sessionId), status: 'queued', pid: null });
  recordSessionWorkspace(sessionId, own);
  recordSessionWorkspace(sessionId, unreadable);

  // The own root's index cannot be written (a full disk); the other root's
  // state cannot even be read.
  const ownState = resolveStateFile(own);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to === ownState) {
      throw Object.assign(new Error(`ENOSPC: injected failure, rename '${String(to)}'`), {
        code: 'ENOSPC',
      });
    }
    return originalRename(from, to);
  });
  const unreadableState = resolveStateFile(unreadable);
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (file === unreadableState) {
      throw Object.assign(new Error('EACCES: injected failure'), { code: 'EACCES' });
    }
    return originalRead(file, options as Parameters<typeof fs.readFileSync>[1]);
  }) as typeof fs.readFileSync);

  await handleSessionEnd(
    { hook_event_name: 'SessionEnd', session_id: sessionId, cwd: own },
    { ops: fakeProcesses().ops },
  );
  t.mock.restoreAll();
  // Nothing is kept for a later end of the same session.
  assert.deepEqual(readSessionWorkspaces(sessionId), []);
  assert.equal(indexed(unreadable, 'task-other')?.status, 'queued', 'the unread root is untouched');
});

test('a session ended by /clear or /resume keeps its jobs, their processes, and its registry', async (t) => {
  useTempCodexHome(t);
  for (const reason of ['clear', 'resume']) {
    const sessionId = `sess-${reason}`;
    const id = `task-${reason}`;
    const workspace = resolveWorkspaceRoot(makeTempDir());
    seedJob(workspace, runningJob(id, sessionId));
    recordSessionWorkspace(sessionId, workspace);
    const fake = fakeProcesses();

    await handleSessionEnd(
      { hook_event_name: 'SessionEnd', session_id: sessionId, cwd: workspace, reason },
      { ops: fake.ops },
    );
    assert.deepEqual(fake.signalled, [], reason);
    for (const record of [indexed(workspace, id), readJobFile(resolveJobFile(workspace, id))]) {
      assert.equal(record?.status, 'running', reason);
      assert.equal(record?.pid, WORKER_PID, reason);
      assert.equal(record?.claudePid, CLAUDE_PID, reason);
    }
    assert.deepEqual(readSessionWorkspaces(sessionId), [workspace], reason);
  }
});

test('SessionEnd stops the pids the settle read, not the stale snapshot', async (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const sessionId = 'sess-late-worker';
  // The second job's index row still says queued with no worker when the
  // sweep loads it, but its worker has started since and recorded itself in
  // the job file: the settle reads that under the index lock.
  const first = { ...runningJob('task-first', sessionId), claudePid: null };
  const second = {
    ...runningJob('task-second', sessionId),
    status: 'queued',
    pid: null,
    claudePid: null,
    updatedAt: '2026-09-25T08:00:30.000Z',
  };
  const lateWorker = WORKER_PID + 10;
  seedJob(workspace, first);
  seedJob(workspace, { ...second, status: 'running', pid: lateWorker }, second);
  const fake = fakeProcesses();
  const swept = cleanupSessionJobs([workspace], sessionId, { ops: fake.ops });
  assert.deepEqual(swept, { codexKilled: 0 });
  assert.deepEqual(
    fake.signalled.map(([pid]) => pid),
    [WORKER_PID, lateWorker],
    'the worker that started after the snapshot is stopped too',
  );
  assert.deepEqual(
    [indexed(workspace, first.id), indexed(workspace, second.id)],
    [undefined, undefined],
  );
});

test('SessionEnd settles every job before it signals any, and a worker starting late never runs', async (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const sessionId = 'sess-phased';
  const first = { ...runningJob('task-first', sessionId), claudePid: null };
  const second = {
    ...runningJob('task-second', sessionId),
    claudePid: null,
    pid: WORKER_PID + 20,
    updatedAt: '2026-09-25T08:00:30.000Z',
  };
  seedJob(workspace, first);
  seedJob(workspace, second);
  const fake = fakeProcesses();
  const statusAtFirstSignal: Array<string | undefined> = [];
  const swept = cleanupSessionJobs([workspace], sessionId, {
    ops: {
      ...fake.ops,
      terminate: (pid, options) => {
        if (fake.signalled.length === 0) {
          statusAtFirstSignal.push(
            readJobFile(resolveJobFile(workspace, first.id)).status,
            readJobFile(resolveJobFile(workspace, second.id)).status,
          );
        }
        fake.ops.terminate(pid, options);
      },
    },
  });
  assert.deepEqual(swept, { codexKilled: 0 });
  assert.deepEqual(
    [indexed(workspace, first.id), indexed(workspace, second.id)],
    [undefined, undefined],
  );
  assert.deepEqual(statusAtFirstSignal, ['cancelled', 'cancelled'], 'both settled first');
  assert.deepEqual(
    fake.signalled.map(([pid]) => pid),
    [WORKER_PID, WORKER_PID + 20],
  );
});
