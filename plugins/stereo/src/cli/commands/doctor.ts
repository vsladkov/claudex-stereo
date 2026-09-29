import fs from 'node:fs';

import {
  loadBrokerSession,
  probeBrokerEndpoint,
  resolveBrokerStateFile,
} from '../../broker/lifecycle.ts';
import { listWorktrees } from '../../platform/git.ts';
import { PROCESS_OPS, recordedProcessGone } from '../../platform/process.ts';
import type { ProcessOps } from '../../platform/process.ts';
import { renderDoctorReport } from '../../render/render.ts';
import type { DoctorRenderReport, StalledJobEntry } from '../../render/render.ts';
import { optionalString, recordedPid, recordLike } from '../../shared/json.ts';
import { jobRuntime } from '../../shared/runtime.ts';
import {
  getConfig,
  isActiveJob,
  listJobs,
  readImplementStateFile,
  readTournamentStateFile,
  resolveDurableStateDir,
  resolveImplementStateFile,
  resolveJobsDir,
  resolveStateFile,
  resolveTournamentStateFile,
  setConfig,
} from '../../workspace/state.ts';
import { resolveCodexHome } from '../../workspace/thread-lock-io.ts';
import { buildSetupReport } from './setup.ts';
import { worktreeRemoveCommand } from './worktree.ts';
import {
  outputReportResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import { errorMessage } from '../../shared/errors.ts';

export type DoctorReport = DoctorRenderReport;

export interface DoctorDeps {
  buildSetupReport: typeof buildSetupReport;
  loadBrokerSession: typeof loadBrokerSession;
  probeBrokerEndpoint: typeof probeBrokerEndpoint;
  listWorktrees: typeof listWorktrees;
  /** The process seams (the broker's liveness, the stall check). */
  ops: ProcessOps;
}

export const defaultDoctorDeps: DoctorDeps = {
  buildSetupReport,
  loadBrokerSession,
  probeBrokerEndpoint,
  listWorktrees,
  ops: PROCESS_OPS,
};

// A queued job may simply not have started yet; only one this old with no
// live worker counts as stalled. A record with no pid has nothing the
// worker check could judge, so its age is all that tells a launch that died
// before it recorded its worker from one still starting.
const STALLED_QUEUED_AGE_MS = 120_000;

// Active records whose worker is gone (recordedProcessGone: the cheap check
// status and `status --wait` share), for /stereo:cancel to settle.
export function findStalledJobs(workspaceRoot: string, deps: DoctorDeps): StalledJobEntry[] {
  const stalled: StalledJobEntry[] = [];
  for (const job of listJobs(workspaceRoot)) {
    if (!isActiveJob(job)) {
      continue;
    }
    // A worker that is not gone (a live pid it cannot tell apart included) is no stall.
    const workerMayStillRun =
      recordedPid(job.pid) !== null && !recordedProcessGone(job.pid, job.pidStart, deps.ops);
    if (workerMayStillRun) {
      continue;
    }
    if (job.status === 'queued' && job.pid == null) {
      const created = Date.parse(job.createdAt ?? '');
      if (!Number.isFinite(created) || Date.now() - created < STALLED_QUEUED_AGE_MS) {
        continue;
      }
    }
    stalled.push({
      id: job.id,
      title: typeof job.title === 'string' ? job.title : null,
      status: job.status,
      runtime: jobRuntime(job),
      pid: typeof job.pid === 'number' ? job.pid : null,
    });
  }
  return stalled;
}

export async function buildDoctorReport(
  cwd: string,
  actionsTaken: string[] = [],
  deps: DoctorDeps = defaultDoctorDeps,
): Promise<DoctorReport> {
  const workspaceRoot = resolveCommandWorkspace({ cwd });
  const setup = await deps.buildSetupReport(cwd);
  const nextSteps: string[] = [];

  const brokerSession = deps.loadBrokerSession(workspaceRoot);
  let pidAlive: boolean | null = null;
  if (brokerSession?.pid) {
    try {
      pidAlive = !deps.ops.processHasExited(brokerSession.pid);
    } catch {
      pidAlive = null;
    }
  }
  let endpointReachable: boolean | null = null;
  if (brokerSession?.endpoint) {
    try {
      endpointReachable = await deps.probeBrokerEndpoint(brokerSession.endpoint, 500);
    } catch {
      endpointReachable = null;
    }
  }
  if (brokerSession?.logFile) {
    nextSteps.push(
      `Broker-side failures are recorded only in ${brokerSession.logFile}; inspect that file when broker requests fail.`,
    );
  }

  const codexHome = resolveCodexHome();
  const durableStateDir = resolveDurableStateDir(workspaceRoot);
  const stateFile = resolveStateFile(workspaceRoot);
  const jobsDir = resolveJobsDir(workspaceRoot);

  const implementState = readImplementStateFile(workspaceRoot);
  const implementRecord = recordLike(implementState.record);
  const worktreeRecord = recordLike(implementRecord?.worktree);
  const implementStatus = optionalString(implementRecord?.status);
  if (implementStatus === 'in-progress') {
    nextSteps.push(
      `An implementation record is in progress at ${resolveImplementStateFile(workspaceRoot)}; continue it with /stereo:implement --resume.`,
    );
  }

  const tournamentState = readTournamentStateFile(workspaceRoot);
  const tournamentRecord = recordLike(tournamentState.record);
  const tournamentStatus = optionalString(tournamentRecord?.status);
  const tournamentWinner = recordLike(tournamentRecord?.winner);
  if (tournamentStatus === 'in-progress') {
    nextSteps.push(
      `A tournament record is in progress at ${resolveTournamentStateFile(workspaceRoot)}; continue it with /stereo:tournament --resume.`,
    );
  }

  let worktreeListing: ReturnType<typeof listWorktrees>;
  try {
    worktreeListing = deps.listWorktrees(workspaceRoot);
  } catch (error) {
    worktreeListing = {
      available: false,
      entries: [],
      detail: errorMessage(error),
    };
  }
  const stereoWorktrees = worktreeListing.entries
    .filter((entry) => entry.path.split(/[\\/]+/).includes('stereo-worktrees'))
    .map((entry) => ({
      ...entry,
      removeCommand: worktreeRemoveCommand(workspaceRoot, entry.path),
    }));
  for (const entry of stereoWorktrees) {
    nextSteps.push(`Remove the stranded worktree with ${entry.removeCommand}.`);
  }

  const stalledJobs = findStalledJobs(workspaceRoot, deps);
  for (const job of stalledJobs) {
    nextSteps.push(
      `Job ${job.id} still shows as ${job.status} but its worker process is gone; settle it with /stereo:cancel ${job.id}.`,
    );
  }

  const lastJobAnnouncementAt = getConfig(workspaceRoot).lastJobAnnouncementAt ?? null;
  const parsedWatermark = lastJobAnnouncementAt ? Date.parse(lastJobAnnouncementAt) : Number.NaN;
  const watermarkParsed = lastJobAnnouncementAt !== null && !Number.isNaN(parsedWatermark);
  const watermarkFuture = watermarkParsed && parsedWatermark > Date.now();
  const resetCommand = '/stereo:doctor --reset-job-announcements';
  if (watermarkFuture) {
    nextSteps.push(
      `The SessionStart announcement watermark is in the future and suppresses finished-job announcements; reset it with ${resetCommand}.`,
    );
  }

  return {
    workspaceRoot,
    setup,
    broker: {
      recorded: Boolean(brokerSession),
      path: resolveBrokerStateFile(workspaceRoot),
      endpoint: brokerSession?.endpoint ?? null,
      pid: brokerSession?.pid ?? null,
      pidAlive,
      endpointReachable,
      logFile: brokerSession?.logFile ?? null,
      sessionDir: brokerSession?.sessionDir ?? null,
    },
    state: {
      codexHome,
      durableStateDir,
      stateFile,
      jobsDir,
      exists: {
        codexHome: fs.existsSync(codexHome),
        durableStateDir: fs.existsSync(durableStateDir),
        stateFile: fs.existsSync(stateFile),
        jobsDir: fs.existsSync(jobsDir),
      },
    },
    implementRecord: {
      path: resolveImplementStateFile(workspaceRoot),
      present: !implementState.missing,
      unreadable: Boolean(implementState.parseError),
      parseError: implementState.parseError,
      status: implementStatus,
      baselineCommit: optionalString(implementRecord?.baselineCommit),
      round: implementRecord?.round ?? null,
      worktree: optionalString(worktreeRecord?.path),
    },
    tournamentRecord: {
      path: resolveTournamentStateFile(workspaceRoot),
      present: !tournamentState.missing,
      unreadable: Boolean(tournamentState.parseError),
      parseError: tournamentState.parseError,
      status: tournamentStatus,
      baselineCommit: optionalString(tournamentRecord?.baselineCommit),
      contestants: Array.isArray(tournamentRecord?.contestants)
        ? tournamentRecord.contestants.length
        : 0,
      winner: optionalString(tournamentWinner?.label),
    },
    worktrees: {
      available: worktreeListing.available,
      detail: worktreeListing.detail,
      entries: stereoWorktrees,
    },
    jobAnnouncements: {
      lastJobAnnouncementAt,
      parsed: watermarkParsed,
      future: watermarkFuture,
      resetCommand,
    },
    stalledJobs,
    actionsTaken,
    nextSteps,
  };
}

export async function handleDoctor(
  argv: string[],
  deps: DoctorDeps = defaultDoctorDeps,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'workspace'],
    booleanOptions: ['json', 'reset-job-announcements'],
  });
  if (positionals.length > 0) {
    throw new Error('doctor takes only flags; unexpected positional arguments.');
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken: string[] = [];
  if (options['reset-job-announcements']) {
    setConfig(workspaceRoot, 'lastJobAnnouncementAt', null);
    actionsTaken.push(`Reset the SessionStart job-announcement watermark for ${workspaceRoot}.`);
  }

  const reportCwd = Object.hasOwn(options, 'workspace') ? workspaceRoot : cwd;
  const report = await buildDoctorReport(reportCwd, actionsTaken, deps);
  outputReportResult(report, renderDoctorReport(report), options.json);
}
