import fs from 'node:fs';
import path from 'node:path';

import {
  loadBrokerSession,
  probeBrokerEndpoint,
  resolveBrokerStateFile,
} from '../../broker/lifecycle.ts';
import { readModelCatalogDrift } from '../../models/catalog-cache.ts';
import { listWorktrees } from '../../platform/git.ts';
import { processHasExited } from '../../platform/process.ts';
import { renderDoctorReport } from '../../render/render.ts';
import type { DoctorRenderReport } from '../../render/render.ts';
import { optionalString, recordLike } from '../../shared/json.ts';
import { outputResult } from '../../shared/text.ts';
import {
  getConfig,
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
import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from '../io.ts';

export type DoctorReport = DoctorRenderReport;

export interface DoctorDeps {
  buildSetupReport: typeof buildSetupReport;
  loadBrokerSession: typeof loadBrokerSession;
  probeBrokerEndpoint: typeof probeBrokerEndpoint;
  processHasExited: typeof processHasExited;
  listWorktrees: typeof listWorktrees;
  readModelCatalogDrift: typeof readModelCatalogDrift;
}

export const defaultDoctorDeps: DoctorDeps = {
  buildSetupReport,
  loadBrokerSession,
  probeBrokerEndpoint,
  processHasExited,
  listWorktrees,
  readModelCatalogDrift,
};

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
      pidAlive = !deps.processHasExited(brokerSession.pid);
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
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const stereoWorktrees = worktreeListing.entries
    .filter((entry) => entry.path.split(/[\\/]+/).includes('stereo-worktrees'))
    .map((entry) => ({
      ...entry,
      removeCommand: `git -C "${workspaceRoot}" worktree remove --force "${entry.path}"`,
    }));
  for (const entry of stereoWorktrees) {
    nextSteps.push(`Remove the stranded worktree with ${entry.removeCommand}.`);
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

  let modelCatalog: ReturnType<typeof readModelCatalogDrift>;
  try {
    modelCatalog = deps.readModelCatalogDrift();
  } catch (error) {
    modelCatalog = {
      available: false,
      path: path.join(codexHome, 'models_cache.json'),
      reason: error instanceof Error ? error.message : String(error),
      fetchedAt: null,
      clientVersion: null,
      entries: [],
      warnings: [],
    };
  }
  nextSteps.push(...modelCatalog.warnings);

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
    modelCatalog,
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
  outputResult(options.json ? report : renderDoctorReport(report), options.json);
}
