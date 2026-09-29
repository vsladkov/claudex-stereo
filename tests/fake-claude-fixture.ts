import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildClaudeArgs } from '../plugins/stereo/src/runtime/claude-runner.ts';
import { makeTempDir, writeExecutable } from './helpers.ts';
import { initializeBasicRepo, readJsonIfReadable } from './runtime-helpers.ts';

// A fake `claude` binary for spawn-level tests of the headless transport. It
// answers `--version`, `auth status --json`, and `-p` runs: the prompt comes
// from stdin, every flag the companion passed is recorded into
// fake-claude-state.json, and a stream-json event sequence is written to
// stdout. Behaviors switch the sequence: default (a text answer, or a
// structured verdict when --json-schema is present), 'logged-out',
// 'old-version', 'denied-write', 'invalid-structured', 'die-mid-run',
// 'error-result', 'auth-expired-result' (is_error with subtype success),
// 'bash-denied' (a denied Bash call inside a reviewer run), 'interruptible'
// (emits init, then waits for SIGTERM and records that it was terminated),
// 'stubborn' (like interruptible, but ignores SIGTERM: only SIGKILL ends it),
// 'slow-after-bash' (emits init and an open Bash call, then goes silent),
// 'result-then-hang' (reports a normal result, then never exits until it is
// signalled), 'result-then-stderr' (reports a normal result, then keeps
// writing a stderr line every 50 ms until it is signalled),
// 'background-sleeper' (POSIX: starts a helper it never waits for, records
// its pid as sleeperPid, and exits normally, leaving the helper in its
// process group), 'exit-with-pipe-holder' (POSIX: like background-sleeper,
// but the helper inherits stdout and stderr, so the pipes stay open after the
// run exits; its pid is recorded as pipeHolderPid),
// 'exit-with-escaped-pipe-holder' (the same helper started detached, in a
// session of its own that no group kill reaches), 'verify-then-format' (a
// write-role run that, after the default calls, runs `npx prettier --write
// src` and then `npm test && git status`), 'background-bash' (a write-role
// run that, after the default calls, starts `npm run dev` with
// run_in_background and then runs `npm test`), 'reruns' (a write-role run
// that, after the default calls, reruns commands: `npm test` failing, `npm run
// lint` passing twice with `npx tsc --noEmit` between, `npm run build`
// passing and then denied, and `npx vitest run` passing and then left open,
// so it ends interrupted). Every run records its own
// pid and the child environment the companion controls (effort, scrubbed
// parent state, the terminal-title and working-directory switches).
export function installFakeClaude(binDir: string, behavior = 'default'): void {
  const statePath = path.join(binDir, 'fake-claude-state.json');
  const scriptPath = path.join(binDir, 'claude');
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { runs: [], sessions: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
// Mirrors the CLI's option grammar closely enough for the flags the companion sends.
function parseArgs(argv) {
  const valueFlags = new Set(["--output-format", "--model", "--effort", "--agents", "--agent", "--setting-sources", "--settings", "--permission-prompts", "--permission-mode", "--json-schema", "--resume", "--input-format"]);
  const parsed = { flags: {}, allowedTools: [], positionals: [], print: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-p" || token === "--print") { parsed.print = true; continue; }
    if (token === "--allowedTools" || token === "--allowed-tools") {
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) { parsed.allowedTools.push(argv[index + 1]); index += 1; }
      continue;
    }
    if (valueFlags.has(token)) { parsed.flags[token.slice(2)] = argv[index + 1]; index += 1; continue; }
    if (token.startsWith("--")) { parsed.flags[token.slice(2)] = true; continue; }
    parsed.positionals.push(token);
  }
  return parsed;
}

const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(BEHAVIOR === "old-version" ? "2.1.200 (Claude Code)\\n" : "2.1.281 (Claude Code)\\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  if (BEHAVIOR === "logged-out") {
    process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "fake@example.com", subscriptionType: "team" }) + "\\n");
  process.exit(0);
}
const parsed = parseArgs(argv);
if (!parsed.print) {
  process.stderr.write("fake claude: only -p runs are supported\\n");
  process.exit(2);
}
const prompt = readStdin();
const state = loadState();
const sessionId = parsed.flags.resume || crypto.randomUUID();
const model = parsed.flags.model || "claude-sonnet-5";
// What the run reports as served: the request itself unless a test names the
// id an alias resolved to (the real CLI reports the full id for "opus").
const served = process.env.FAKE_CLAUDE_SERVED_MODEL || model;
const agentsFile = parsed.flags.agents || null;
const agentsDefinition = agentsFile && fs.existsSync(agentsFile) ? JSON.parse(fs.readFileSync(agentsFile, "utf8")) : null;
const run = {
  args: argv,
  flags: parsed.flags,
  allowedTools: parsed.allowedTools,
  model,
  effort: parsed.flags.effort || null,
  envEffort: process.env.CLAUDE_CODE_EFFORT_LEVEL || null,
  envClaudeEffort: process.env.CLAUDE_EFFORT || null,
  envCompanionSession: process.env.CODEX_COMPANION_SESSION_ID || null,
  envMessagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || null,
  envSessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
  envChildSession: process.env.CLAUDE_CODE_CHILD_SESSION || null,
  envSessionAttended: process.env.CLAUDE_CODE_SESSION_ATTENDED || null,
  envClaudePid: process.env.CLAUDE_PID || null,
  envDisableTerminalTitle: process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE || null,
  envMaintainWorkingDir: process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR || null,
  envCi: process.env.CI || null,
  agent: parsed.flags.agent || null,
  agentsDefinition,
  jsonSchema: parsed.flags["json-schema"] ? JSON.parse(parsed.flags["json-schema"]) : null,
  resume: parsed.flags.resume || null,
  permissionMode: parsed.flags["permission-mode"] || null,
  cwd: process.cwd(),
  prompt,
  sessionId,
  pid: process.pid,
};
state.runs.push(run);
state.lastRun = run;
state.sessions[sessionId] = (state.sessions[sessionId] || 0) + 1;
saveState(state);

if (BEHAVIOR === "logged-out") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sessionId, num_turns: 0, total_cost_usd: 0, modelUsage: {}, permission_denials: [] });
  process.exit(1);
}

const init = { type: "system", subtype: "init", session_id: sessionId, model: served, permissionMode: parsed.flags["permission-mode"] || "default", tools: ["Read", "Bash"], plugins: [], mcp_servers: [] };
emit(init);
const usage = { input_tokens: 4, cache_creation_input_tokens: 600, cache_read_input_tokens: 1200, output_tokens: 40 };
const modelUsage = {
  [served]: { inputTokens: 4, outputTokens: 40, cacheReadInputTokens: 1200, cacheCreationInputTokens: 600, contextWindow: 200000, costUSD: 0.01, canonicalModel: served },
  "claude-haiku-4-5": { inputTokens: 2, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.0001, canonicalModel: "claude-haiku-4-5" }
};
const finish = (fields) => {
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, num_turns: 2, duration_ms: 20, total_cost_usd: 0.01, usage: { ...usage, output_tokens_details: { thinking_tokens: 3 } }, modelUsage, permission_denials: [], terminal_reason: "completed", ...fields });
};
const assistant = (content, id) => emit({ type: "assistant", message: { id, role: "assistant", content, usage }, session_id: sessionId });

if (BEHAVIOR === "die-mid-run") {
  assistant([{ type: "text", text: "Working..." }], "msg_1");
  process.exit(137);
}
if (BEHAVIOR === "interruptible") {
  assistant([{ type: "text", text: "Working until told to stop..." }], "msg_1");
  const mark = (signal) => {
    const latest = loadState();
    latest.terminated = { signal, sessionId };
    saveState(latest);
    process.exit(143);
  };
  process.on("SIGTERM", () => mark("SIGTERM"));
  process.on("SIGINT", () => mark("SIGINT"));
  setInterval(() => {}, 1000);
  return;
}
if (BEHAVIOR === "stubborn") {
  // Ignores the polite signal: whoever stops it (cancel, a signal handler,
  // the inactivity kill) has to escalate to SIGKILL.
  assistant([{ type: "text", text: "Working until told to stop..." }], "msg_1");
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);
  return;
}
if (BEHAVIOR === "result-then-hang") {
  // The result is in, but the process lingers (an unflushed call, a helper
  // it waits on): the transport stops it once the post-result grace passes.
  assistant([{ type: "text", text: "Done, but lingering." }], "msg_1");
  finish({ result: "Done, but lingering." });
  setInterval(() => {}, 1000);
  return;
}
if (BEHAVIOR === "result-then-stderr") {
  // Chatter after the result must not extend the post-result deadline.
  assistant([{ type: "text", text: "Done, still talking." }], "msg_1");
  finish({ result: "Done, still talking." });
  setInterval(() => process.stderr.write("still flushing\\n"), 50);
  return;
}
if (BEHAVIOR === "exit-with-pipe-holder" || BEHAVIOR === "exit-with-escaped-pipe-holder") {
  // The helper inherits this run's stdout and stderr: the pipes outlive the
  // run for as long as the helper does. Escaped, it leads a session of its
  // own, beyond the reach of the run's group kill.
  const { spawn } = require("node:child_process");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "stand-in:fake-claude-pipe-holder"], { stdio: ["ignore", "inherit", "inherit"], detached: BEHAVIOR === "exit-with-escaped-pipe-holder" });
  holder.unref();
  const latest = loadState();
  latest.pipeHolderPid = holder.pid;
  saveState(latest);
  assistant([{ type: "text", text: "Left a helper holding the pipes." }], "msg_1");
  finish({ result: "Left a helper holding the pipes." });
  process.exit(0);
}
if (BEHAVIOR === "background-sleeper") {
  // A helper left running in the run's own process group (not detached: a
  // detached one would escape any group kill by design): the transport's
  // group kill at exit must take it along.
  const { spawn } = require("node:child_process");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "stand-in:fake-claude-sleeper"], { stdio: "ignore" });
  sleeper.unref();
  const latest = loadState();
  latest.sleeperPid = sleeper.pid;
  saveState(latest);
  assistant([{ type: "text", text: "Started a helper." }], "msg_1");
  finish({ result: "Started a helper." });
  process.exit(0);
}
if (BEHAVIOR === "slow-after-bash") {
  // A Bash call that never reports: the run goes silent with the call still
  // open, so the inactivity kill lands on a pending command. The sleep is
  // far longer than any inactivity budget a test sets; a signal ends it.
  assistant([{ type: "tool_use", id: "tu_hang", name: "Bash", input: { command: "npm test", description: "Run the tests" } }], "msg_1");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  process.exit(0);
}
if (BEHAVIOR === "auth-expired-result") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sessionId, num_turns: 0, total_cost_usd: 0, modelUsage: {}, permission_denials: [] });
  process.exit(1);
}
if (BEHAVIOR === "error-result") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, num_turns: 1, total_cost_usd: 0.001, usage, modelUsage, permission_denials: [], errors: ["The model claude-opus-9 does not exist"], terminal_reason: "error" });
  process.exit(1);
}

const isResume = Boolean(parsed.flags.resume);
const isWriteRole = parsed.flags["permission-mode"] === "acceptEdits";
if (isWriteRole) {
  const target = path.join(process.cwd(), "implemented.txt");
  assistant([{ type: "tool_use", id: "tu_write", name: "Write", input: { file_path: target, content: "implemented" } }], "msg_w");
  fs.writeFileSync(target, "implemented\\n");
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_write", content: "File created successfully at: " + target }] }, session_id: sessionId });
  assistant([{ type: "tool_use", id: "tu_bash", name: "Bash", input: { command: "npm test", description: "Run the tests" } }], "msg_b");
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_bash", content: "ok" }] }, session_id: sessionId });
  assistant([{ type: "tool_use", id: "tu_bash_fail", name: "Bash", input: { command: "npm run lint", description: "Lint" } }], "msg_b2");
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_bash_fail", is_error: true, content: "lint failed: unexpected token" }] }, session_id: sessionId });
  if (BEHAVIOR === "denied-write") {
    const outside = path.join(path.dirname(process.cwd()), "outside.txt");
    assistant([{ type: "tool_use", id: "tu_denied", name: "Write", input: { file_path: outside, content: "nope" } }], "msg_d");
    emit({ type: "system", subtype: "permission_denied", tool_name: "Write", tool_use_id: "tu_denied", decision_reason_type: "asyncAgent", session_id: sessionId });
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_denied", is_error: true, content: "Permission to use Write has been denied." }] }, session_id: sessionId });
    assistant([{ type: "text", text: "Files touched:\\n- implemented.txt\\n\\nDeviations:\\n- outside.txt was denied" }], "msg_t");
    finish({ result: "Files touched:\\n- implemented.txt\\n\\nDeviations:\\n- outside.txt was denied", permission_denials: [{ tool_name: "Write", tool_use_id: "tu_denied", tool_input: { file_path: outside, content: "nope" } }] });
    process.exit(0);
  }
  const bash = (id, input, result) => {
    assistant([{ type: "tool_use", id, name: "Bash", input }], "msg_" + id);
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] }, session_id: sessionId });
  };
  if (BEHAVIOR === "verify-then-format") {
    bash("tu_format", { command: "npx prettier --write src", description: "Format" }, "src/a.ts 12ms");
    bash("tu_recheck", { command: "npm test && git status", description: "Re-run the tests" }, "ok");
  }
  if (BEHAVIOR === "background-bash") {
    bash("tu_dev", { command: "npm run dev", description: "Start the dev server", run_in_background: true }, "Command running in background with ID: bash_1");
    bash("tu_late_test", { command: "npm test", description: "Run the tests" }, "ok");
  }
  if (BEHAVIOR === "reruns") {
    assistant([{ type: "tool_use", id: "tu_test_red", name: "Bash", input: { command: "npm test" } }], "msg_tr");
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_test_red", is_error: true, content: "1 failing" }] }, session_id: sessionId });
    bash("tu_lint_green", { command: "npm run lint" }, "ok");
    bash("tu_tsc", { command: "npx tsc --noEmit" }, "ok");
    bash("tu_lint_again", { command: "npm run lint" }, "ok");
    bash("tu_build", { command: "npm run build" }, "ok");
    assistant([{ type: "tool_use", id: "tu_build_denied", name: "Bash", input: { command: "npm run build" } }], "msg_bd");
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_build_denied", is_error: true, content: "Permission to use Bash with command npm run build has been denied." }] }, session_id: sessionId });
    bash("tu_vitest", { command: "npx vitest run" }, "ok");
    // Left open: the run ends while it still runs.
    assistant([{ type: "tool_use", id: "tu_vitest_open", name: "Bash", input: { command: "npx vitest run" } }], "msg_vo");
  }
  const report = "Files touched:\\n- implemented.txt\\n\\nPlan steps completed:\\n- all\\n\\nVerification:\\n- npm test — exit 0\\n\\nDeviations:\\n- none";
  assistant([{ type: "text", text: report }], "msg_t");
  finish({ result: report });
  process.exit(0);
}

if (run.jsonSchema) {
  const properties = run.jsonSchema.properties || {};
  let structured;
  if (properties.verdict && properties.revision_instructions) {
    structured = { verdict: isResume ? "approve" : "needs-revision", summary: isResume ? "Revised plan is acceptable." : "Plan needs a verification step.", findings: isResume ? [] : [{ severity: "high", title: "Missing verification step", body: "The plan never runs the test suite.", section: "Verification", confidence: 0.9, recommendation: "Add the gate." }], revision_instructions: isResume ? [] : ["Add a verification step."], open_questions: [], residual_risks: [] };
  } else if (properties.acceptable) {
    structured = { acceptable: true, summary: "Implementation matches the plan.", fixes: [] };
  } else {
    structured = { verdict: "approve", summary: "No blocking issues found.", findings: [], next_steps: [] };
  }
  if (BEHAVIOR === "invalid-structured") {
    assistant([{ type: "text", text: "not json at all" }], "msg_1");
    finish({ result: "not json at all" });
    process.exit(0);
  }
  assistant([{ type: "tool_use", id: "tu_so", name: "StructuredOutput", input: structured }], "msg_1");
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_so", content: "Structured output provided successfully" }] }, session_id: sessionId });
  finish({ result: JSON.stringify(structured), structured_output: structured });
  process.exit(0);
}

assistant([{ type: "thinking", thinking: "Considering the request carefully before answering." }], "msg_0");
assistant([{ type: "tool_use", id: "tu_read", name: "Read", input: { file_path: "README.md" } }], "msg_1");
emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_read", content: "hello" }] }, session_id: sessionId });
if (BEHAVIOR === "bash-denied") {
  assistant([{ type: "tool_use", id: "tu_bash_denied", name: "Bash", input: { command: "npm test", description: "Run the tests" } }], "msg_1b");
  emit({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "tu_bash_denied", decision_reason_type: "mode", session_id: sessionId });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_bash_denied", is_error: true, content: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." }] }, session_id: sessionId });
}
const answer = isResume ? "Resumed the prior Claude session." : "Handled the requested task.\\nTask prompt accepted.";
assistant([{ type: "text", text: answer }], "msg_2");
finish({ result: answer, ...(BEHAVIOR === "bash-denied" ? { permission_denials: [{ tool_name: "Bash", tool_use_id: "tu_bash_denied", tool_input: { command: "npm test", description: "Run the tests" } }] } : {}) });
process.exit(0);
`;
  writeExecutable(scriptPath, source);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), `@echo off\r\nnode "%~dp0claude" %*\r\n`, {
      encoding: 'utf8',
    });
  }
}

export interface FakeClaudeRun {
  args: string[];
  flags: Record<string, string | boolean>;
  allowedTools: string[];
  model: string;
  effort: string | null;
  envEffort: string | null;
  envClaudeEffort: string | null;
  envCompanionSession: string | null;
  envMessagingSocket: string | null;
  envSessionId: string | null;
  envChildSession: string | null;
  envSessionAttended: string | null;
  envClaudePid: string | null;
  envDisableTerminalTitle: string | null;
  envMaintainWorkingDir: string | null;
  envCi: string | null;
  agent: string | null;
  agentsDefinition: Record<string, Record<string, unknown>> | null;
  jsonSchema: Record<string, unknown> | null;
  resume: string | null;
  permissionMode: string | null;
  cwd: string;
  prompt: string;
  sessionId: string;
  /** The fake's own pid, so a test can prove a run's child dead afterwards. */
  pid: number;
}

export interface FakeClaudeState {
  runs: FakeClaudeRun[];
  lastRun?: FakeClaudeRun;
  sessions: Record<string, number>;
  terminated?: { signal: string; sessionId: string };
  /** The helper a 'background-sleeper' run left in its process group. */
  sleeperPid?: number;
  /** The helper an 'exit-with-(escaped-)pipe-holder' run left holding its pipes. */
  pipeHolderPid?: number;
}

// The fake rewrites its state file while a run is live, so a read may land
// on a torn write; a waitFor predicate must see "nothing yet", never throw.
export function readFakeClaudeState(binDir: string): FakeClaudeState {
  return (
    readJsonIfReadable<FakeClaudeState>(path.join(binDir, 'fake-claude-state.json')) ?? {
      runs: [],
      sessions: {},
    }
  );
}

// A worker killed outright never removes its run's directory (the agents
// file's, under the system temp directory). The test that killed it removes
// the directory of every run its fake recorded.
export function removeFakeClaudeRunDirs(binDir: string): void {
  for (const recorded of readFakeClaudeState(binDir).runs) {
    const agentsFile = recorded.flags.agents;
    if (typeof agentsFile !== 'string') {
      continue;
    }
    const dir = path.dirname(agentsFile);
    if (path.basename(dir).startsWith('stereo-claude-')) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// The fake leads PATH, ahead of the preload's decoy, and CLAUDE_CODE_EXECPATH
// names it too: the transport prefers the exec path, which on Windows the
// preload points at the decoy.
export function buildClaudeEnv(
  binDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv & { PATH: string; CLAUDE_CODE_EXECPATH: string } {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...base,
    PATH: `${binDir}${sep}${base.PATH ?? ''}`,
    CLAUDE_CODE_EXECPATH: path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
  };
}

export interface FakeClaudeBin {
  binDir: string;
  env: ReturnType<typeof buildClaudeEnv>;
}

// A fake `claude` with the given behaviour on a PATH entry of its own, plus
// the environment that makes the transport pick it: the prologue of every
// spawn-level test, and what lets one repository be driven by several fakes.
export function fakeClaudeBin(behavior = 'default'): FakeClaudeBin {
  const binDir = makeTempDir();
  installFakeClaude(binDir, behavior);
  return { binDir, env: buildClaudeEnv(binDir) };
}

// The prologue of nearly every test: a committed repo plus a fake `claude`.
export function claudeFixture(behavior = 'default'): FakeClaudeBin & { repo: string } {
  return { repo: initializeBasicRepo(), ...fakeClaudeBin(behavior) };
}

// The plainest run the transport can be asked for: no role, no grants.
export function plainArgs(): string[] {
  return buildClaudeArgs({
    model: 'sonnet',
    effort: null,
    write: false,
    agentsFile: null,
    agentName: null,
    grants: [],
  });
}
