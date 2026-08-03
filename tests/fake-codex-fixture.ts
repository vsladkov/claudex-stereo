import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { writeExecutable } from './helpers.ts';

export function installFakeCodex(binDir: string, behavior = 'review-ok'): void {
  const statePath = path.join(binDir, 'fake-codex-state.json');
  const scriptPath = path.join(binDir, 'codex');
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: thread.modelProvider || "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function emptyTokenUsage() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

function addTokenUsage(total, sample) {
  return {
    totalTokens: total.totalTokens + sample.totalTokens,
    inputTokens: total.inputTokens + sample.inputTokens,
    cachedInputTokens: total.cachedInputTokens + sample.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + sample.cacheWriteInputTokens,
    outputTokens: total.outputTokens + sample.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + sample.reasoningOutputTokens
  };
}

function buildTokenUsageNotifications(threadId, turnId, multiplier = 1) {
  const state = loadState();
  const thread = ensureThread(state, threadId);
  let total = thread.tokenUsage || emptyTokenUsage();
  const samples = [
    {
      totalTokens: 100 * multiplier,
      inputTokens: 80 * multiplier,
      cachedInputTokens: 20 * multiplier,
      cacheWriteInputTokens: 5 * multiplier,
      outputTokens: 20 * multiplier,
      reasoningOutputTokens: 5 * multiplier
    },
    {
      totalTokens: 250 * multiplier,
      inputTokens: 200 * multiplier,
      cachedInputTokens: 100 * multiplier,
      cacheWriteInputTokens: 10 * multiplier,
      outputTokens: 50 * multiplier,
      reasoningOutputTokens: 10 * multiplier
    }
  ];
  const notifications = samples.map((last) => {
    total = addTokenUsage(total, last);
    return {
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { ...total },
          last,
          modelContextWindow: 258000
        }
      }
    };
  });
  thread.tokenUsage = total;
  saveState(state);
  return notifications;
}

function emitTokenUsage(threadId, turnId, multiplier = 1) {
  for (const notification of buildTokenUsageNotifications(threadId, turnId, multiplier)) {
    send(notification);
  }
}

function emitSlowTurnProgress(threadId, turnId) {
  const initialPlan = [
    { step: "inspect existing capture flow", status: "completed" },
    { step: "summarize live file changes", status: "inProgress" },
    { step: "verify progress reporting", status: "pending" }
  ];
  const advancedPlan = [
    { step: "inspect existing capture flow", status: "completed" },
    { step: "summarize live file changes", status: "completed" },
    { step: "verify progress reporting", status: "inProgress" }
  ];
  const diff = [
    "diff --git a/src/one.ts b/src/one.ts",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1 +1 @@",
    "-old value",
    "+new value",
    "diff --git a/src/two.ts b/src/two.ts",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -0,0 +1 @@",
    "+second file"
  ].join("\\n");
  const foreignDiff = [
    "diff --git a/foreign.ts b/foreign.ts",
    "--- a/foreign.ts",
    "+++ b/foreign.ts",
    "@@ -0,0 +1 @@",
    "+foreign turn content"
  ].join("\\n");

  send({
    method: "turn/plan/updated",
    params: { threadId, turnId, explanation: null, plan: initialPlan }
  });
  send({ method: "turn/diff/updated", params: { threadId, turnId, diff } });
  send({ method: "turn/diff/updated", params: { threadId, turnId, diff } });
  send({
    method: "turn/diff/updated",
    params: { threadId, turnId: turnId + "_foreign", diff: foreignDiff }
  });
  send({
    method: "turn/plan/updated",
    params: { threadId, turnId, explanation: null, plan: advancedPlan }
  });
}

function sandboxPolicy(requested) {
  if (requested === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false
    };
  }
  return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: {
          model_provider: "ollama",
          model_providers: {
            ollama: {
              name: "Ollama",
              env_key: "OLLAMA_API_KEY"
            }
          }
        },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "CUSTOM_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    case "refreshable-auth":
    case "logged-out":
      return {
        config: {
          model_provider: "openai",
          model_providers: {
            moonshot: {
              name: "Moonshot",
              env_key: "MOONSHOT_API_KEY"
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function buildAccountRateLimitsResult() {
  const rateLimits = {
    limitId: "codex",
    limitName: "Codex",
    primary: {
      usedPercent: 37,
      windowDurationMins: 300,
      resetsAt: 1785000000
    },
    secondary: {
      usedPercent: 12,
      windowDurationMins: 10080,
      resetsAt: 1785500000
    },
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null
  };
  return {
    rateLimits,
    rateLimitsByLimitId: { codex: rateLimits },
    rateLimitResetCredits: null
  };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  emitTokenUsage(threadId, turnId);
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  if (prompt.includes("adversarial plan review")) {
    if (BEHAVIOR === "plan-review-scalar-json") {
      return JSON.stringify("needs-revision");
    }

    if (BEHAVIOR === "plan-review-approve") {
      return JSON.stringify({
        verdict: "approve",
        summary: "The plan is workable.",
        findings: [],
        revision_instructions: [],
        open_questions: [],
        residual_risks: []
      });
    }

    return JSON.stringify({
      verdict: "needs-revision",
      summary: "One plan gap must be addressed before implementation.",
      findings: [
        {
          severity: "high",
          title: "Missing verification step",
          body: "The plan never states how the change will be verified.",
          section: "Approach",
          confidence: 0.9,
          recommendation: "Add a testing and verification step to the plan."
        }
      ],
      revision_instructions: ["Add a Testing and verification section covering the new behavior."],
      open_questions: ["Should the new flag default to on?"],
      residual_risks: ["A pre-existing retry helper swallows errors; out of scope here, worth a follow-up plan."]
    });
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "logged-out" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] === "sandbox") {
  if (BEHAVIOR === "sandbox-blocked") {
    console.error("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    process.exit(1);
  }
  if (BEHAVIOR === "sandbox-unsupported") {
    console.error("error: unrecognized subcommand 'sandbox'");
    process.exit(2);
  }
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
bootState.lastAppServerPid = process.pid;
bootState.codexHome = process.env.CODEX_HOME || null;
const configPath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "config.toml") : null;
bootState.configContents = configPath && fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
if (BEHAVIOR === "slow-exit") {
  let slowExitScheduled = false;
  const scheduleSlowExit = () => {
    if (slowExitScheduled) {
      return;
    }
    slowExitScheduled = true;
    setTimeout(() => process.exit(0), 1000);
  };
  rl.on("close", scheduleSlowExit);
  process.on("SIGTERM", scheduleSlowExit);
}
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "account/rateLimits/read":
        if (BEHAVIOR === "rate-limits-fail") {
          send({
            id: message.id,
            error: { code: -32601, message: "Unsupported method: account/rateLimits/read" }
          });
        } else {
          send({ id: message.id, result: buildAccountRateLimitsResult() });
        }
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const requestedProvider = message.params.modelProvider ?? "openai";
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        thread.modelProvider = requestedProvider;
        state.lastThreadStart = {
          model: message.params.model ?? null,
          modelProvider: requestedProvider,
          sandbox: message.params.sandbox ?? null,
          cwd: message.params.cwd ?? null
        };
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: requestedProvider, serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: sandboxPolicy(message.params.sandbox), reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        const requestedProvider = message.params.modelProvider ?? "openai";
        thread.modelProvider = requestedProvider;
        state.lastResume = {
          threadId: message.params.threadId,
          model: message.params.model ?? null,
          modelProvider: requestedProvider,
          sandbox: message.params.sandbox ?? null
        };
        // Auth preflights change app-server start counts but never resume a
        // thread, so the write-resume attempt is the scenario-invariant signal.
        const staleWriteResume =
          BEHAVIOR === "stale-write-escalation" && message.params.sandbox === "workspace-write";
        if (staleWriteResume) {
          state.writeSandboxResumeAttempts = (state.writeSandboxResumeAttempts || 0) + 1;
        }
        saveState(state);
        const reportedSandbox =
          BEHAVIOR === "resume-never-escalates" ||
          (staleWriteResume && state.writeSandboxResumeAttempts === 1)
            ? sandboxPolicy("read-only")
            : sandboxPolicy(message.params.sandbox);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: requestedProvider, serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: reportedSandbox, reasoningEffort: null } });
        if (BEHAVIOR === "die-after-resume") {
          setImmediate(() => process.exit(23));
        }
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

	      case "review/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
	          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
	        }
	        const turnId = nextTurnId(state);
	        state.lastReviewStart = {
	          sourceThreadId: thread.id,
	          reviewThreadId: reviewThread.id,
	          turnId
	        };
	        saveState(state);
	        const reviewResult = { turn: buildTurn(turnId), reviewThreadId: reviewThread.id };
	        const reviewItems = [
	          {
	            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
	          {
	            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
	          }
	        ];
	        if (BEHAVIOR === "slow-start-response") {
	          // Detached reviews complete only on reviewThreadId. Emit that
	          // completion before the delayed response so broker tests exercise
	          // the response-derived expected-completion id.
	          emitTurnCompleted(reviewThread.id, turnId, reviewItems);
	          setTimeout(() => send({ id: message.id, result: reviewResult }), 800);
	        } else {
	          send({ id: message.id, result: reviewResult });
	          emitTurnCompleted(reviewThread.id, turnId, reviewItems);
	        }
	        break;
	      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          outputSchema: message.params.outputSchema ?? null,
	          prompt
	        };
		        state.turnStarts = Array.isArray(state.turnStarts) ? state.turnStarts : [];
		        state.turnStarts.push({ threadId: message.params.threadId, turnId });
		        saveState(state);
		        const withholdStartResponse =
		          BEHAVIOR === "withheld-start-response" && state.turnStarts.length === 1;
		        if (BEHAVIOR === "wedged-turn") {
	          send({ id: message.id, result: { turn: buildTurn(turnId) } });
	          break;
	        }
		        if (BEHAVIOR === "turn-start-no-turn") {
	          // Some responses may omit the turn object entirely; the capture
	          // must still complete via thread-scoped notifications.
	          send({ id: message.id, result: {} });
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          emitTokenUsage(thread.id, turnId);
	          send({
	            method: "item/completed",
	            params: {
	              threadId: thread.id,
	              turnId,
	              item: { type: "agentMessage", id: "msg_" + turnId, text: taskPayload(prompt, false), phase: "final_answer" }
	            }
	          });
	          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          break;
	        }

	        if (BEHAVIOR === "fast-turn") {
	          const fastPayload = taskPayload(prompt, false);
		          const lines = [
		            { id: message.id, result: { turn: buildTurn(turnId) } },
		            { method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } },
		            ...buildTokenUsageNotifications(thread.id, turnId),
		            {
	              method: "item/completed",
	              params: {
	                threadId: thread.id,
	                turnId,
	                item: { type: "agentMessage", id: "msg_" + turnId, text: fastPayload, phase: "final_answer" }
	              }
	            },
	            { method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } }
		          ];
		          // One write so the response and the completion land in a single
		          // stream chunk. A short dispatch delay also gives a raw client
		          // time to close before that chunk, making the dead-socket race
		          // deterministic without changing the response/completion order.
		          setTimeout(
		            () => process.stdout.write(lines.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n"),
		            25
		          );
		          break;
		        }

		        if (BEHAVIOR !== "slow-start-response" && !withholdStartResponse) {
		          send({ id: message.id, result: { turn: buildTurn(turnId) } });
		        }

        if (BEHAVIOR === "die-mid-turn") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          setTimeout(() => process.exit(23), 10);
          break;
        }

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          emitTokenUsage(thread.id, turnId);
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          emitTokenUsage(subThread.id, subTurnId, 2);
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          ...(BEHAVIOR === "provider-probe" && state.turnStarts.length === 1
            ? [
                {
                  completed: {
                    type: "commandExecution",
                    id: "command_" + turnId,
                    command: "node --version",
                    cwd: thread.cwd,
                    processId: null,
                    source: "agent",
                    status: "completed",
                    commandActions: [],
                    aggregatedOutput: process.version,
                    exitCode: 0,
                    durationMs: 1
                  }
                }
              ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

        if (BEHAVIOR === "malformed-notification") {
          send({ method: "item/completed", params: { threadId: thread.id, turnId } });
        }

		        if (
		          BEHAVIOR === "slow-turn" ||
		          BEHAVIOR === "slow-start-response" ||
		          withholdStartResponse
		        ) {
		          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
		          if (BEHAVIOR === "slow-turn") {
		            emitSlowTurnProgress(thread.id, turnId);
		          }
		          const timer = setTimeout(() => {
		            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            emitTokenUsage(thread.id, turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
		            }
		            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
		          }, withholdStartResponse ? 30000 : 1500);
		          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
		          if (BEHAVIOR === "slow-start-response") {
		            setTimeout(
		              () => send({ id: message.id, result: { turn: buildTurn(turnId) } }),
		              800
		            );
		          }
		        } else if (BEHAVIOR === "interruptible-slow-task") {
		          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
		          const timer = setTimeout(() => {
		            if (!interruptibleTurns.has(turnId)) {
		              return;
		            }
			            interruptibleTurns.delete(turnId);
			            emitTokenUsage(thread.id, turnId);
			            for (const entry of items) {
		              if (entry && entry.completed) {
		                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
		              }
		            }
		            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
		          }, 5000);
		          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
		        } else if (BEHAVIOR === "slow-task") {
		          emitTurnCompletedLater(thread.id, turnId, items, 400);
		        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === 'win32') {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, 'codex.cmd'), cmdWrapper, { encoding: 'utf8' });
  }
}

export type FakeCodexEnv = NodeJS.ProcessEnv & { PATH: string; CODEX_HOME: string };

export function buildEnv(binDir: string): FakeCodexEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    CODEX_HOME: path.join(binDir, 'codex-home'),
  };
}
