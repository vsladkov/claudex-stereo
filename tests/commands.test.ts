import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "stereo");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

// Structural wiring only. Prose is deliberately unpinned: regex-freezing doc
// sentences preserved stale text (a pinned README example once asserted a
// model name that no longer existed) while taxing every legitimate edit.

test("the command surface is exactly the ten stereo commands", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "implement.md",
    "plan.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("every command wires the companion entry point it documents", () => {
  const wiring: Record<string, RegExp> = {
    "adversarial-review.md": /codex-companion\.ts" adversarial-review "\$ARGUMENTS"/,
    "cancel.md": /codex-companion\.ts" cancel "\$ARGUMENTS"/,
    "implement.md": /task --background --json --write --thread/,
    "plan.md": /plan-review --background --json --round 1/,
    "rescue.md": /task-resume-candidate --json/,
    "result.md": /codex-companion\.ts" result "\$ARGUMENTS"/,
    "review.md": /codex-companion\.ts" review "\$ARGUMENTS"/,
    "setup.md": /codex-companion\.ts" setup --json \$ARGUMENTS/,
    "status.md": /codex-companion\.ts" status "\$ARGUMENTS"/,
    "transfer.md": /codex-companion\.ts" transfer "\$ARGUMENTS"/
  };
  for (const [file, token] of Object.entries(wiring)) {
    const source = read(path.join("commands", file));
    assert.match(source, /codex-companion\.ts/, `${file} must reference the companion entry point`);
    assert.match(source, token, `${file} runtime wiring drifted`);
  }
});

test("directly-wired commands disable model invocation of the command file", () => {
  for (const file of [
    "adversarial-review.md",
    "cancel.md",
    "implement.md",
    "plan.md",
    "result.md",
    "review.md",
    "status.md",
    "transfer.md"
  ]) {
    assert.match(read(path.join("commands", file)), /^disable-model-invocation:\s*true$/m, file);
  }
});

test("plan and implement keep the pair-workflow loop mechanics", () => {
  const plan = read("commands/plan.md");
  assert.match(plan, /status <jobId> --wait --timeout-ms 540000 --json/);
  assert.match(plan, /plan-review --background --json --thread <threadId> --round <n>/);
  assert.match(plan, /<<'CODEX_PAIR_PLAN'/);

  const implement = read("commands/implement.md");
  assert.match(implement, /plan-state --json/);
  assert.match(implement, /status <jobId> --wait --timeout-ms 540000 --json/);
  assert.match(implement, /<<'CODEX_PAIR_IMPL'/);
  assert.match(implement, /<<'CODEX_PAIR_FIX'/);
});

test("rescue routes through the subagent transport, never Skill recursion", () => {
  const rescue = read("commands/rescue.md");
  // Regression for #234: `Skill(stereo:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose while running
  // under `context: fork` — forked general-purpose subagents do not expose
  // the `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "stereo:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(stereo:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.ts/);
  assert.match(source, /session-lifecycle-hook\.ts/);
});
