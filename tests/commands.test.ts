import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'stereo');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

// Structural wiring only. Prose is deliberately unpinned: regex-freezing doc
// sentences preserved stale text (a pinned README example once asserted a
// model name that no longer existed) while taxing every legitimate edit.

test('the command surface is exactly the twelve stereo commands', () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, 'commands')).sort();
  assert.deepEqual(commandFiles, [
    'adversarial-review.md',
    'cancel.md',
    'implement.md',
    'plan-state.md',
    'plan.md',
    'quick.md',
    'rescue.md',
    'result.md',
    'review.md',
    'setup.md',
    'status.md',
    'transfer.md',
  ]);
});

test('every command wires the companion entry point it documents', () => {
  const wiring: Record<string, RegExp | RegExp[]> = {
    'adversarial-review.md': /codex-companion\.ts" adversarial-review "\$ARGUMENTS"/,
    'cancel.md': /codex-companion\.ts" cancel "\$ARGUMENTS"/,
    'implement.md': /task --background --json --write --thread/,
    'plan-state.md': /codex-companion\.ts" plan-state \$ARGUMENTS/,
    'plan.md': [/plan-review --background --json --round 1/, /plan-store --json/],
    'quick.md': [
      /plan-review --background --json --round 1/,
      /task --background --json --write --thread/,
    ],
    'rescue.md': /task-resume-candidate --json/,
    'result.md': /codex-companion\.ts" result "\$ARGUMENTS"/,
    'review.md': /codex-companion\.ts" review "\$ARGUMENTS"/,
    'setup.md': /codex-companion\.ts" setup --json \$ARGUMENTS/,
    'status.md': /codex-companion\.ts" status "\$ARGUMENTS"/,
    'transfer.md': /codex-companion\.ts" transfer "\$ARGUMENTS"/,
  };
  for (const [file, required] of Object.entries(wiring)) {
    const source = read(path.join('commands', file));
    assert.match(source, /codex-companion\.ts/, `${file} must reference the companion entry point`);
    for (const token of Array.isArray(required) ? required : [required]) {
      assert.match(source, token, `${file} runtime wiring drifted`);
    }
  }
});

test('directly-wired commands disable model invocation of the command file', () => {
  for (const file of [
    'adversarial-review.md',
    'cancel.md',
    'implement.md',
    'plan-state.md',
    'plan.md',
    'quick.md',
    'result.md',
    'review.md',
    'status.md',
    'transfer.md',
  ]) {
    assert.match(read(path.join('commands', file)), /^disable-model-invocation:\s*true$/m, file);
  }
});

test('pair commands load the canonical routing skill and keep workflow wiring', () => {
  const routing = read('skills/model-routing/SKILL.md');
  assert.match(routing, /status <jobId> --wait --timeout-ms 90000 --json/);
  for (const role of [
    'planner',
    'plan-reviewer',
    'implementer',
    'implementation-reviewer',
    'adversarial-reviewer',
  ]) {
    assert.match(routing, new RegExp(`subagent_type: "stereo:${role}"`), role);
  }
  assert.ok(
    (routing.match(/run_in_background: false/g) ?? []).length >= 5,
    'all routing-skill Agent templates must stay foreground',
  );

  const plan = read('commands/plan.md');
  assert.match(plan, /skills\/model-routing\/SKILL\.md/);
  assert.match(plan, /plan-review --background --json --thread <planReviewThreadId> --round <n>/);
  assert.match(plan, /<<'CODEX_PAIR_PLAN'/);
  assert.match(plan, /plan-store --json/);
  assert.match(plan, /schemas\/plan-review-output\.schema\.json/);
  assert.match(plan, /^allowed-tools:.*\bAgent\b.*$/m);
  assert.match(plan.match(/^argument-hint:.*$/m)?.[0] ?? '', /--draft-only/);
  assert.match(plan.match(/^argument-hint:.*$/m)?.[0] ?? '', /--review-only/);

  const implement = read('commands/implement.md');
  assert.match(implement, /skills\/model-routing\/SKILL\.md/);
  assert.match(implement, /plan-state --json/);
  assert.match(implement, /<<'CODEX_PAIR_PLAN'/);
  assert.match(implement, /<<'CODEX_PAIR_IMPL'/);
  assert.match(implement, /<<'CODEX_PAIR_FIX'/);
  assert.match(implement, /task --background --json --write --model <effectiveModel> <effortArg>/);
  assert.match(implement, /approved outside\s+this Codex thread/);
  assert.match(implement, /reviewed but unapproved/);
  assert.match(implement, /^allowed-tools:.*\bAgent\b.*$/m);
  assert.match(implement, /Compare `git rev-parse HEAD` with `baselineCommit`/);
  assert.match(implement, /implementationReviewThreadId/);
  assert.match(implement, /schemas\/implementation-review-output\.schema\.json/);
  assert.match(implement.match(/^argument-hint:.*$/m)?.[0] ?? '', /--implement-only/);
  assert.match(implement.match(/^argument-hint:.*$/m)?.[0] ?? '', /--review-only/);

  const quick = read('commands/quick.md');
  assert.match(quick, /skills\/model-routing\/SKILL\.md/);
  assert.match(quick, /plan-state --json/);
  assert.match(quick, /<<'CODEX_PAIR_PLAN'/);
  assert.match(quick, /<<'CODEX_PAIR_IMPL'/);
  assert.match(quick, /<<'CODEX_PAIR_FIX'/);
  assert.match(quick, /plan-store --json/);
  assert.match(quick, /^allowed-tools:.*\bAgent\b.*$/m);
  assert.match(quick, /plannerThreadId/);
  assert.match(quick, /planReviewThreadId/);
  assert.match(quick, /implementationThreadId/);
  assert.match(quick, /implementationReviewThreadId/);

  const adversarial = read('commands/adversarial-review.md');
  assert.match(adversarial, /skills\/model-routing\/SKILL\.md/);
  assert.match(adversarial, /prompts\/adversarial-review\.md/);
  assert.match(adversarial, /schemas\/review-output\.schema\.json/);
  assert.match(adversarial, /^allowed-tools:.*\bAgent\b.*$/m);

  const nativeReview = read('commands/review.md');
  assert.match(nativeReview, /does not accept Claude models/);
  assert.match(nativeReview, /\/stereo:adversarial-review/);
});

test('pair agents keep their role-specific tool and output contracts', () => {
  const expectedAgents = [
    'adversarial-reviewer.md',
    'codex-rescue.md',
    'implementation-reviewer.md',
    'implementer.md',
    'plan-reviewer.md',
    'planner.md',
  ];
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).sort(), expectedAgents);

  const implementer = read('agents/implementer.md');
  assert.match(implementer, /^tools:\s*Read, Glob, Grep, Edit, Write$/m);
  assert.doesNotMatch(implementer.match(/^---\n[\s\S]*?\n---/)?.[0] ?? '', /\bBash\b/);

  const planReviewer = read('agents/plan-reviewer.md');
  assert.match(planReviewer, /plugins\/stereo\/schemas\/plan-review-output\.schema\.json/);
  assert.match(planReviewer, /"section"/);
  assert.match(planReviewer, /"confidence"/);

  const adversarialReviewer = read('agents/adversarial-reviewer.md');
  assert.match(adversarialReviewer, /schemas\/review-output\.schema\.json/);

  const implementationReviewer = read('agents/implementation-reviewer.md');
  assert.match(implementationReviewer, /schemas\/implementation-review-output\.schema\.json/);

  assert.doesNotThrow(() => JSON.parse(read('schemas/implementation-review-output.schema.json')));

  for (const file of expectedAgents.filter((file) => file !== 'codex-rescue.md')) {
    assert.match(read(path.join('agents', file)), /run_in_background: false/, file);
  }
});

test('rescue routes through the subagent transport, never Skill recursion', () => {
  const rescue = read('commands/rescue.md');
  // Regression for #234: `Skill(stereo:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose while running
  // under `context: fork` — forked general-purpose subagents do not expose
  // the `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "stereo:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(stereo:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
});

test('hooks keep session-end cleanup and stop gating enabled', () => {
  const source = read('hooks/hooks.json');
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.ts/);
  assert.match(source, /session-lifecycle-hook\.ts/);
});
