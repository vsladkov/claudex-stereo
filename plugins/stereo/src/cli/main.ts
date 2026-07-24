import process from "node:process";

import { wasJsonRequested } from "./io.ts";
import { printUsage } from "./usage.ts";
import { handleSetup } from "./commands/setup.ts";
import { handleAdversarialReview, handleReview } from "./commands/review.ts";
import { handleTask, handleTaskResumeCandidate, handleTaskWorker } from "./commands/task.ts";
import { handlePlanReview, handlePlanState } from "./commands/plan.ts";
import { handleTransfer } from "./commands/transfer.ts";
import { handleResult, handleStatus } from "./commands/status.ts";
import { handleCancel } from "./commands/cancel.ts";

async function main(fullArgv: string[]): Promise<void> {
  const [subcommand, ...argv] = fullArgv;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "plan-review":
      await handlePlanReview(argv);
      break;
    case "plan-state":
      handlePlanState(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

export function runCli(argv: string[]): Promise<void> {
  return main(argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (wasJsonRequested()) {
      // --json consumers parse stdout; give failures the same structured
      // surface as successes (stderr keeps the human-readable text).
      console.log(JSON.stringify({ error: message }));
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
