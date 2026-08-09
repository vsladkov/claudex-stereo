import process from 'node:process';

import { resetJsonRequestState, wasJsonRequested } from './io.ts';
import { printUsage } from './usage.ts';

// Each case imports its handler lazily: a static import list here pulled the
// entire 60+-module graph (workflows, runtime, transport, broker, render)
// into every invocation, taxing trivial calls like `version` or a status
// poll with ~100-200ms of parse/instantiation.
async function main(fullArgv: string[]): Promise<void> {
  const [subcommand, ...argv] = fullArgv;
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printUsage();
    return;
  }

  switch (subcommand) {
    case 'config':
      await (await import('./commands/config.ts')).handleConfig(argv);
      break;
    case 'setup':
      await (await import('./commands/setup.ts')).handleSetup(argv);
      break;
    case 'doctor':
      await (await import('./commands/doctor.ts')).handleDoctor(argv);
      break;
    case 'review':
      await (await import('./commands/review.ts')).handleReview(argv);
      break;
    case 'adversarial-review':
      await (await import('./commands/review.ts')).handleAdversarialReview(argv);
      break;
    case 'task':
      await (await import('./commands/task.ts')).handleTask(argv);
      break;
    case 'plan-review':
      await (await import('./commands/plan.ts')).handlePlanReview(argv);
      break;
    case 'plan-state':
      await (await import('./commands/plan.ts')).handlePlanState(argv);
      break;
    case 'plan-store':
      await (await import('./commands/plan.ts')).handlePlanStore(argv);
      break;
    case 'implement-state':
      (await import('./commands/implement.ts')).handleImplementState(argv);
      break;
    case 'tournament-state':
      (await import('./commands/tournament.ts')).handleTournamentState(argv);
      break;
    case 'transfer':
      await (await import('./commands/transfer.ts')).handleTransfer(argv);
      break;
    case 'task-worker':
      await (await import('./commands/task.ts')).handleTaskWorker(argv);
      break;
    case 'status':
      await (await import('./commands/status.ts')).handleStatus(argv);
      break;
    case 'result':
      (await import('./commands/status.ts')).handleResult(argv);
      break;
    case 'task-resume-candidate':
      (await import('./commands/task.ts')).handleTaskResumeCandidate(argv);
      break;
    case 'cancel':
      await (await import('./commands/cancel.ts')).handleCancel(argv);
      break;
    case 'version':
      (await import('./commands/version.ts')).handleVersion(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

export function runCli(argv: string[]): Promise<void> {
  resetJsonRequestState();
  return main(argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (wasJsonRequested(argv)) {
      // --json consumers parse stdout; give failures the same structured
      // surface as successes (stderr keeps the human-readable text).
      console.log(JSON.stringify({ error: message }));
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
