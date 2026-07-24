import process from "node:process";

import {
  describeStrandedReservation,
  getCodexAuthStatus,
  getCodexAvailability,
  getCodexWriteSandboxStatus,
  getSessionRuntimeStatus,
  listStrandedThreadReservations
} from "../../runtime/index.ts";
import { binaryAvailable } from "../../platform/process.ts";
import { getConfig, setConfig } from "../../workspace/state.ts";
import { resolveWorkspaceRoot } from "../../workspace/workspace.ts";
import { renderSetupReport } from "../../render/render.ts";
import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../io.ts";
import { outputResult } from "../../shared/text.ts";

export async function buildSetupReport(cwd: string, actionsTaken: string[] = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const writeSandbox = codexStatus.available ? getCodexWriteSandboxStatus(cwd) : null;
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);
  const strandedReservations = listStrandedThreadReservations();

  const nextSteps: string[] = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (writeSandbox?.available === false) {
    nextSteps.push(
      `Write-capable runs (\`/stereo:implement\` and \`task --write\`) will fail because the Codex write sandbox could not start: ${writeSandbox.detail}. On Ubuntu 24.04, this may be caused by the common \`kernel.apparmor_restrict_unprivileged_userns=1\` setting.`
    );
  }
  for (const reservation of strandedReservations) {
    nextSteps.push(describeStrandedReservation(reservation));
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/stereo:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    writeSandbox,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    strandedReservations,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

export async function handleSetup(argv: string[]): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken: string[] = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}
