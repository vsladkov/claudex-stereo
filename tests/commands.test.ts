import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { SESSION_END_BUDGET_MS } from '../plugins/stereo/src/hooks/session-lifecycle.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'stereo');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

// Structural wiring only. Prose is deliberately unpinned: regex-freezing doc
// sentences preserved stale text (a pinned README example once asserted a
// model name that no longer existed) while taxing every legitimate edit.

test('the command surface is exactly the fifteen stereo commands', () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, 'commands')).sort();
  assert.deepEqual(commandFiles, [
    'adversarial-review.md',
    'cancel.md',
    'config.md',
    'doctor.md',
    'implement.md',
    'plan-state.md',
    'plan.md',
    'quick.md',
    'rescue.md',
    'result.md',
    'review.md',
    'setup.md',
    'status.md',
    'tournament.md',
    'transfer.md',
  ]);
});

test('every command wires the companion entry point it documents', () => {
  const wiring: Record<string, RegExp | RegExp[]> = {
    'adversarial-review.md': /codex-companion\.ts" adversarial-review "\$ARGUMENTS"/,
    'cancel.md': /codex-companion\.ts" cancel "\$ARGUMENTS"/,
    'config.md': /codex-companion\.ts" config "\$ARGUMENTS"/,
    'doctor.md': /codex-companion\.ts" doctor "\$ARGUMENTS --json"/,
    'implement.md': /task --background --json --write --thread/,
    'plan-state.md': [
      /codex-companion\.ts" plan-state\b/,
      /plan-state --list/,
      /plan-state --clear/,
      /plan-state --mark-implemented/,
    ],
    'plan.md': [/plan-review --background --json --round 1/, /plan-store --json/],
    'quick.md': [
      /plan-review --background --json --round 1/,
      /task --background --json --write --thread/,
    ],
    'rescue.md': /task-resume-candidate --json/,
    'result.md': /codex-companion\.ts" result "\$ARGUMENTS"/,
    'review.md': /codex-companion\.ts" review "\$ARGUMENTS"/,
    'setup.md': /codex-companion\.ts" setup "\$ARGUMENTS --json"/,
    'status.md': /codex-companion\.ts" status "\$ARGUMENTS"/,
    'tournament.md': [
      /task --background --json --write --model <contestantModel>/,
      /plan-state --json <slotArg>/,
      /tournament-state --record --state-file "<statePayloadFile>"/,
      /tournament-state --json/,
      /worktree add --detach/,
      /subagent_type: "stereo:implementer"/,
    ],
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

test('companion invocations quote raw slash-command arguments consistently', () => {
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) {
    const lines = read(path.join('commands', file)).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.includes('codex-companion.ts') && line.includes('$ARGUMENTS')) {
        assert.match(line, /"\$ARGUMENTS( [^"]*)?"/, `${file}:${index + 1}`);
      }
    }
  }
});

test('directly-wired commands disable model invocation of the command file', () => {
  for (const file of [
    'adversarial-review.md',
    'cancel.md',
    'config.md',
    'doctor.md',
    'implement.md',
    'plan-state.md',
    'plan.md',
    'quick.md',
    'rescue.md',
    'result.md',
    'review.md',
    'setup.md',
    'status.md',
    'tournament.md',
    'transfer.md',
  ]) {
    assert.match(read(path.join('commands', file)), /^disable-model-invocation:\s*true$/m, file);
  }
});

test('pair commands load the canonical routing skill and keep workflow wiring', () => {
  const continuationSection = 'Continuing an agent across review rounds';
  const routing = read('skills/model-routing/SKILL.md');
  assert.match(
    routing,
    /status <jobId> --wait --timeout-ms 90000 \| grep -E 'Phase\|Elapsed\|\^ \{4\}'/,
  );
  assert.match(routing, /result <jobId> --json/);
  for (const role of [
    'planner',
    'plan-reviewer',
    'implementer',
    'implementation-reviewer',
    'reviewer',
    'adversarial-reviewer',
  ]) {
    assert.match(routing, new RegExp(`subagent_type: "stereo:${role}"`), role);
  }
  assert.ok(
    (routing.match(/run_in_background: false/g) ?? []).length >= 6,
    'all routing-skill Agent templates must stay foreground',
  );
  assert.equal(
    (routing.match(/^model: "<sonnet\|opus\|haiku\|fable>"$/gm) ?? []).length,
    6,
    'all explicit Claude aliases must keep passing an invocation-level model',
  );
  assert.match(routing, /\|\s*`claude:inherit`\s*\|/);
  assert.match(routing, new RegExp(`^## ${continuationSection}$`, 'm'));
  assert.equal(
    (routing.match(/--findings-file "<findingsPayloadFile>"/g) ?? []).length,
    1,
    'the canonical Claude persistence rule must deliver findings separately',
  );
  for (const [flag, placeholder] of [
    ['--summary-file', 'summaryPayloadFile'],
    ['--open-questions-file', 'openQuestionsPayloadFile'],
    ['--residual-risks-file', 'residualRisksPayloadFile'],
  ] as const) {
    assert.equal(
      (routing.match(new RegExp(`${flag} "<${placeholder}>"`, 'g')) ?? []).length,
      1,
      `the canonical Claude persistence rule must wire ${flag} once`,
    );
  }
  assert.doesNotMatch(routing, /--summary '/);
  assert.match(routing, /`<slotArg>` is `--slot <slot>`/);

  const plan = read('commands/plan.md');
  assert.match(plan, /skills\/model-routing\/SKILL\.md/);
  assert.match(
    plan,
    /plan-review --background --json --thread <planReviewThreadId> --round <n> <slotArg>/,
  );
  assert.match(plan, /plan-store --json/);
  assert.match(plan, /schemas\/plan-review-output\.schema\.json/);
  assert.match(plan, /^allowed-tools:.*\bWrite\b.*\bAgent\b.*$/m);
  assert.match(plan, /`<plannerSelectionArgs>` = `--model/);
  assert.match(plan, /`<reviewSelectionArgs>` =\s*\n?\s*`--model/);
  assert.match(plan, /config --json/);
  assert.match(
    plan,
    /plan-review --background --json --round 1 <slotArg> <reviewSelectionArgs> --plan-file "<planFile>"/,
  );
  const planReviewLaunchLines = plan
    .split('\n')
    .filter((line) => line.includes('plan-review --background'));
  assert.equal(planReviewLaunchLines.length, 4);
  for (const line of planReviewLaunchLines) {
    assert.match(line, /<slotArg>/);
  }
  assert.match(plan, /`<slotArg>` = `--slot <slot>`/);
  assert.equal(
    (plan.match(/^node .*plan-store .* < "<planFile>"$/gm) ?? []).length,
    1,
    'Plan intake must persist the user-provided plan bytes by stdin redirect',
  );
  assert.equal(
    (plan.match(/--plan-file "<payloadFile>"/g) ?? []).length,
    3,
    'Plan must deliver all three review payloads by file',
  );
  assert.equal(
    (plan.match(/--prompt-file "<payloadFile>"/g) ?? []).length,
    1,
    'Plan must deliver its draft task payload by file',
  );
  assert.equal(
    (plan.match(/^node .*plan-store .* < "<payloadFile>"$/gm) ?? []).length,
    2,
    'Plan must deliver both stored-plan payloads by stdin redirect',
  );
  assert.equal(
    (plan.match(/--findings-file "<findingsPayloadFile>"/g) ?? []).length,
    2,
    'Plan review-only and external intake must deliver findings separately while draft-only stays findings-free',
  );
  assert.equal(
    (plan.match(/--summary-file "<summaryPayloadFile>"/g) ?? []).length,
    3,
    'all Plan persistence paths must deliver summaries by file',
  );
  assert.equal(
    (plan.match(/--open-questions-file "<openQuestionsPayloadFile>"/g) ?? []).length,
    2,
    'both reviewed Plan persistence paths must deliver questions by file',
  );
  assert.equal(
    (plan.match(/--residual-risks-file "<residualRisksPayloadFile>"/g) ?? []).length,
    2,
    'both reviewed Plan persistence paths must deliver risks by file',
  );
  assert.doesNotMatch(plan, /--summary '/);
  assert.doesNotMatch(plan, /<<'CODEX_PAIR_/);
  const planHint = plan.match(/^argument-hint:.*$/m)?.[0] ?? '';
  for (const flag of [
    '--draft-only',
    '--review-only',
    '--plan-file',
    '--planner-effort',
    '--plan-reviewer-effort',
    '--slot',
  ]) {
    assert.match(planHint, new RegExp(flag));
  }

  const implement = read('commands/implement.md');
  assert.match(implement, /skills\/model-routing\/SKILL\.md/);
  assert.match(implement, /plan-state --json/);
  assert.match(implement, /config --json/);
  assert.match(implement, /plan-state --mark-implemented/);
  assert.match(implement, /Define `<slotArg>` as `--slot <slot>`/);
  assert.match(implement, /implement-state --record[^\n]*<slotArg>/);
  assert.match(implement, /task --background --json --write --model <effectiveModel> <effortArg>/);
  assert.match(implement, /approved outside\s+this Codex thread/);
  assert.match(implement, /reviewed but unapproved/);
  assert.equal(
    (implement.match(/Latest stored review findings:/g) ?? []).length,
    3,
    'both Codex variants and the Claude implementer must receive unapproved findings',
  );
  assert.equal(
    (implement.match(/^Advisory review findings/gm) ?? []).length,
    3,
    'both approved Codex variants and the Claude implementer must receive advisory findings',
  );
  assert.match(implement, /^allowed-tools:.*\bWrite\b.*\bAgent\b.*$/m);
  assert.match(implement, /^allowed-tools:.*\bEdit\b/m);
  assert.match(implement, /^allowed-tools:.*Bash\(npm:\*\)/m);
  assert.equal(
    (implement.match(/--prompt-file "<payloadFile>"/g) ?? []).length,
    5,
    'Implement must deliver all five Codex task payloads by file',
  );
  assert.doesNotMatch(implement, /<<'CODEX_PAIR_/);
  assert.match(implement, /Compare `git rev-parse HEAD` with `baselineCommit`/);
  assert.match(implement, /implementationReviewThreadId/);
  assert.match(implement, /schemas\/implementation-review-output\.schema\.json/);
  for (const action of ['record', 'update', 'complete']) {
    assert.match(
      implement,
      new RegExp(`implement-state --${action} --state-file "<statePayloadFile>"`),
    );
  }
  assert.match(implement, /implement-state --clear --json/);
  const implementHint = implement.match(/^argument-hint:.*$/m)?.[0] ?? '';
  for (const flag of [
    '--implement-only',
    '--review-only',
    '--implementer-effort',
    '--implementation-reviewer',
    '--implementation-reviewer-effort',
    '--resume',
    '--base',
    '--isolated',
    '--slot',
  ]) {
    assert.match(implementHint, new RegExp(flag));
  }
  assert.doesNotMatch(implementHint, /--impl-reviewer\b/);
  const implementLines = implement.split('\n');
  const standaloneStart = implementLines.findIndex(
    (line) => line === '## Standalone implementation-review step',
  );
  const standaloneEnd = implementLines.findIndex(
    (line, index) => index > standaloneStart && line.startsWith('## '),
  );
  const isolatedTaskLines = implementLines.filter(
    (line, index) =>
      line.startsWith('node ') &&
      line.includes('task --background') &&
      (line.includes('--write') || line.includes('--output-schema')) &&
      !(index > standaloneStart && index < standaloneEnd),
  );
  assert.equal(isolatedTaskLines.length, 4);
  for (const line of isolatedTaskLines) {
    assert.match(line, /<isolationArgs>/);
  }
  const standaloneTaskLine = implementLines
    .slice(standaloneStart, standaloneEnd)
    .find(
      (line) =>
        line.startsWith('node ') &&
        line.includes('task --background') &&
        line.includes('--output-schema'),
    );
  assert.ok(standaloneTaskLine);
  assert.doesNotMatch(standaloneTaskLine, /<isolationArgs>/);
  assert.equal(
    (
      implement.match(
        /^node .*task --background.*--output-schema "\$\{CLAUDE_PLUGIN_ROOT\}\/schemas\/implementation-review-output\.schema\.json".*--prompt-file "<payloadFile>"$/gm,
      ) ?? []
    ).length,
    2,
    'both implementation-review task templates must keep runtime schema enforcement',
  );

  const tournament = read('commands/tournament.md');
  assert.match(tournament, /skills\/model-routing\/SKILL\.md/);
  assert.match(tournament, /config --json/);
  assert.match(tournament, /plan-state --json <slotArg>/);
  assert.match(tournament, /implement-state --json/);
  assert.match(tournament, /schemas\/implementation-review-output\.schema\.json/);
  assert.match(tournament, /^allowed-tools:.*\bWrite\b.*\bAgent\b.*$/m);
  assert.match(tournament, /^allowed-tools:.*Bash\(npm:\*\)/m);
  assert.equal(
    (tournament.match(/run_in_background: false/g) ?? []).length,
    2,
    'both foreground Agent templates must stay explicit',
  );
  assert.match(tournament, /subagent_type: "stereo:implementer"/);
  assert.match(tournament, /subagent_type: "stereo:implementation-reviewer"/);
  assert.equal(
    (tournament.match(/^\s*model: "<sonnet\|opus\|haiku\|fable>"$/gm) ?? []).length,
    2,
    'both foreground Agent templates must pass an invocation-level model',
  );
  assert.match(tournament, /`c1` = `codex:sol`/);
  assert.match(tournament, /`c2` = `claude:opus`/);
  assert.equal(
    (tournament.match(/--prompt-file "<payloadFile>"/g) ?? []).length,
    2,
    'Tournament must deliver its implementer and reviewer payloads by file',
  );
  const tournamentTaskLines = tournament
    .split('\n')
    .filter((line) => line.startsWith('node ') && line.includes('task --background'));
  assert.equal(tournamentTaskLines.length, 2);
  for (const line of tournamentTaskLines) {
    assert.match(line, /<isolationArgs>/);
  }
  assert.match(tournament, /git -C "<mainRoot>" apply --3way --check/);
  assert.match(tournament, /worktree remove --force/);
  const tournamentHint = tournament.match(/^argument-hint:.*$/m)?.[0] ?? '';
  for (const flag of [
    '--implementer',
    '--implementer-effort',
    '--implementation-reviewer',
    '--effort',
    '--resume',
    '--slot',
  ]) {
    assert.match(tournamentHint, new RegExp(flag));
  }
  assert.match(tournament, /plan-state --mark-implemented/);
  assert.doesNotMatch(tournament, /implement-state --record/);

  const quick = read('commands/quick.md');
  const countContractTag = (source: string, tag: string): number =>
    (source.match(new RegExp(`^\\s*<${tag}>\\s*$`, 'gm')) ?? []).length;
  const contractTagCounts = (source: string) => ({
    actionSafety: countContractTag(source, 'action_safety'),
    completeness: countContractTag(source, 'completeness_contract'),
    verification: countContractTag(source, 'verification_loop'),
    compactOutput: countContractTag(source, 'compact_output_contract'),
  });
  assert.deepEqual(contractTagCounts(implement), {
    actionSafety: 2,
    completeness: 2,
    verification: 3,
    compactOutput: 3,
  });
  assert.deepEqual(contractTagCounts(quick), {
    actionSafety: 2,
    completeness: 2,
    verification: 3,
    compactOutput: 3,
  });
  assert.deepEqual(contractTagCounts(tournament), {
    actionSafety: 1,
    completeness: 1,
    verification: 2,
    compactOutput: 1,
  });
  assert.match(quick, /skills\/model-routing\/SKILL\.md/);
  assert.match(quick, /plan-state --json/);
  assert.match(quick, /config --json/);
  assert.match(quick, /plan-state --mark-implemented/);
  assert.match(quick, /plan-store --json/);
  assert.match(quick, /^allowed-tools:.*\bWrite\b.*\bAgent\b.*$/m);
  assert.match(quick, /^allowed-tools:.*\bEdit\b/m);
  assert.match(quick, /^allowed-tools:.*Bash\(npm:\*\)/m);
  assert.match(quick, /`<plannerSelectionArgs>` = `--model/);
  assert.match(quick, /`<reviewSelectionArgs>` =\s*\n?\s*`--model/);
  assert.match(quick, /`<slotArg>` = `--slot <slot>`/);
  const quickPlanReviewLines = quick
    .split('\n')
    .filter((line) => line.includes('plan-review --background'));
  assert.equal(quickPlanReviewLines.length, 2);
  for (const line of quickPlanReviewLines) {
    assert.match(line, /<slotArg>/);
  }
  assert.equal(
    (quick.match(/--plan-file "<payloadFile>"/g) ?? []).length,
    2,
    'Quick must deliver both plan-review payloads by file',
  );
  assert.equal(
    (quick.match(/--prompt-file "<payloadFile>"/g) ?? []).length,
    5,
    'Quick must deliver all five Codex task payloads by file',
  );
  const quickIsolatedTaskLines = quick
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('node ') &&
        line.includes('task --background') &&
        (line.includes('--write') || line.includes('--output-schema')),
    );
  assert.equal(quickIsolatedTaskLines.length, 4);
  for (const line of quickIsolatedTaskLines) {
    assert.match(line, /<isolationArgs>/);
  }
  assert.equal(
    (quick.match(/^node .*plan-store .* < "<payloadFile>"$/gm) ?? []).length,
    1,
    'Quick must deliver its stored-plan payload by stdin redirect',
  );
  assert.equal(
    (quick.match(/--findings-file "<findingsPayloadFile>"/g) ?? []).length,
    1,
    'Quick must deliver terminal Claude review findings separately',
  );
  assert.equal(
    (quick.match(/--summary-file "<summaryPayloadFile>"/g) ?? []).length,
    1,
    'Quick must deliver its terminal Claude review summary by file',
  );
  assert.equal(
    (quick.match(/--open-questions-file "<openQuestionsPayloadFile>"/g) ?? []).length,
    1,
    'Quick must deliver terminal Claude review questions by file',
  );
  assert.equal(
    (quick.match(/--residual-risks-file "<residualRisksPayloadFile>"/g) ?? []).length,
    1,
    'Quick must deliver terminal Claude review risks by file',
  );
  assert.doesNotMatch(quick, /--summary '/);
  assert.doesNotMatch(quick, /<<'CODEX_PAIR_/);
  assert.match(quick, /plannerThreadId/);
  assert.match(quick, /planReviewThreadId/);
  assert.match(quick, /implementationThreadId/);
  assert.match(quick, /implementationReviewThreadId/);
  assert.equal(
    (quick.match(/^Advisory review findings/gm) ?? []).length,
    2,
    'both approved Codex variants must receive advisory findings',
  );
  const quickHint = quick.match(/^argument-hint:.*$/m)?.[0] ?? '';
  for (const flag of [
    '--planner-effort',
    '--plan-reviewer-effort',
    '--implementer-effort',
    '--implementation-reviewer',
    '--implementation-reviewer-effort',
    '--slot',
    '--isolated',
    '--max-plan-rounds',
    '--max-fix-rounds',
  ]) {
    assert.match(quickHint, new RegExp(flag));
  }
  assert.doesNotMatch(quickHint, /--impl-reviewer\b/);
  assert.equal(
    (
      quick.match(
        /^node .*task --background.*--output-schema "\$\{CLAUDE_PLUGIN_ROOT\}\/schemas\/implementation-review-output\.schema\.json".*--prompt-file "<payloadFile>"$/gm,
      ) ?? []
    ).length,
    1,
    'the Quick implementation-review task template must keep runtime schema enforcement',
  );
  for (const [file, source] of [
    ['plan.md', plan],
    ['implement.md', implement],
    ['quick.md', quick],
  ] as const) {
    assert.equal(
      source.includes(`"${continuationSection}" rule`),
      true,
      `${file} must cite the canonical continuation rule`,
    );
  }

  for (const [file, source] of [
    ['plan.md', plan],
    ['quick.md', quick],
    ['skills/model-routing/SKILL.md', routing],
  ] as const) {
    assert.match(
      source,
      /^node .*plan-store .*--thread.*\|--no-thread.*$/m,
      `${file} must make stored thread ownership explicit`,
    );
  }

  const adversarial = read('commands/adversarial-review.md');
  assert.match(adversarial, /skills\/model-routing\/SKILL\.md/);
  assert.match(adversarial, /prompts\/adversarial-review\.md/);
  assert.match(adversarial, /schemas\/review-output\.schema\.json/);
  assert.match(adversarial, /^allowed-tools:.*\bAgent\b.*$/m);
  assert.match(adversarial, /`claude:inherit`/);
  assert.match(adversarial, /omit the Agent\s+`model` parameter/);
  const adversarialHint = adversarial.match(/^argument-hint:.*$/m)?.[0] ?? '';
  assert.match(adversarialHint, /--pr/);
  assert.match(adversarialHint, /--effort/);
  assert.match(adversarial, /^allowed-tools:.*Bash\(gh:\*\)/m);

  const nativeReview = read('commands/review.md');
  assert.match(nativeReview, /skills\/model-routing\/SKILL\.md/);
  assert.match(nativeReview, /prompts\/review\.md/);
  assert.match(nativeReview, /schemas\/review-output\.schema\.json/);
  assert.match(nativeReview, /`stereo:reviewer`/);
  assert.match(nativeReview, /^allowed-tools:.*\bAgent\b.*$/m);
  assert.match(nativeReview, /run_in_background: false/);
  assert.match(nativeReview, /\/stereo:adversarial-review/);
  assert.match(nativeReview.match(/^argument-hint:.*$/m)?.[0] ?? '', /--pr/);
  assert.match(nativeReview.match(/^argument-hint:.*$/m)?.[0] ?? '', /focus/);
  assert.doesNotMatch(nativeReview.match(/^argument-hint:.*$/m)?.[0] ?? '', /--effort/);
  assert.match(nativeReview, /^allowed-tools:.*Bash\(gh:\*\)/m);

  const status = read('commands/status.md');
  assert.match(status.match(/^argument-hint:.*$/m)?.[0] ?? '', /--usage/);
  assert.match(status.match(/^argument-hint:.*$/m)?.[0] ?? '', /--workspace/);
  const resultCommand = read('commands/result.md');
  assert.match(resultCommand.match(/^argument-hint:.*$/m)?.[0] ?? '', /--report/);
  assert.match(resultCommand.match(/^argument-hint:.*$/m)?.[0] ?? '', /--workspace/);
  assert.match(read('commands/cancel.md').match(/^argument-hint:.*$/m)?.[0] ?? '', /--workspace/);
});

test('pair commands fill the canonical role briefs', () => {
  const plan = read('commands/plan.md');
  const implement = read('commands/implement.md');
  const quick = read('commands/quick.md');
  const tournament = read('commands/tournament.md');

  for (const [file, source] of [
    ['plan.md', plan],
    ['quick.md', quick],
  ] as const) {
    assert.match(source, /prompts\/plan-draft\.md/, `${file} must load the planner brief`);
    assert.match(source, /prompts\/plan-review\.md/, `${file} must load the plan-review brief`);
    for (const token of [
      '{{TASK_TEXT}}',
      '{{SIZE_CONTRACT}}',
      '{{PLAN_INPUT}}',
      '{{ROUND_NUMBER}}',
      '{{REVISION_CONTEXT}}',
      '{{REPO_MAP}}',
    ]) {
      assert.equal(source.includes(token), true, `${file} must name the ${token} fill`);
    }
  }

  for (const [file, source] of [
    ['implement.md', implement],
    ['quick.md', quick],
    ['tournament.md', tournament],
  ] as const) {
    assert.match(
      source,
      /prompts\/implementation-review\.md/,
      `${file} must load the implementation-review brief`,
    );
    for (const token of [
      '{{PLAN_INPUT}}',
      '{{BASELINE_CONTEXT}}',
      '{{REVIEW_CONTEXT}}',
      '{{HOST_RESULTS}}',
    ]) {
      assert.equal(source.includes(token), true, `${file} must name the ${token} fill`);
    }
  }

  assert.doesNotMatch(read('prompts/plan-review.md'), /You are Codex/);
  assert.doesNotMatch(read('prompts/adversarial-review.md'), /You are Codex/);
});

test('pair agents keep their role-specific tool and output contracts', () => {
  const expectedAgents = [
    'adversarial-reviewer.md',
    'codex-rescue.md',
    'implementation-reviewer.md',
    'implementer.md',
    'plan-reviewer.md',
    'planner.md',
    'reviewer.md',
  ];
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).sort(), expectedAgents);

  const implementer = read('agents/implementer.md');
  assert.match(implementer, /^tools:\s*Read, Glob, Grep, Edit, Write$/m);
  assert.doesNotMatch(implementer.match(/^---\n[\s\S]*?\n---/)?.[0] ?? '', /\bBash\b/);

  const planReviewer = read('agents/plan-reviewer.md');
  assert.match(planReviewer, /schemas\/plan-review-output\.schema\.json/);
  assert.match(planReviewer, /"section"/);
  assert.match(planReviewer, /"confidence"/);

  const adversarialReviewer = read('agents/adversarial-reviewer.md');
  assert.match(adversarialReviewer, /schemas\/review-output\.schema\.json/);

  assert.match(read('agents/reviewer.md'), /schemas\/review-output\.schema\.json/);

  const implementationReviewer = read('agents/implementation-reviewer.md');
  assert.match(implementationReviewer, /schemas\/implementation-review-output\.schema\.json/);

  assert.doesNotThrow(() => JSON.parse(read('schemas/implementation-review-output.schema.json')));

  const rescueAgent = read('agents/codex-rescue.md');
  assert.match(rescueAgent, /^tools:\s*Read, Bash$/m);
  const rescueFrontmatter = rescueAgent.match(/^---\n[\s\S]*?\n---/)?.[0] ?? '';
  for (const skill of ['codex-cli-runtime', 'codex-prompting', 'codex-result-handling']) {
    assert.match(rescueFrontmatter, new RegExp(`^  - ${skill}$`, 'm'));
  }
  assert.match(read('commands/result.md'), /codex-result-handling/);
  const rescueRuntime = read('skills/codex-cli-runtime/SKILL.md');
  for (const [file, source] of [
    ['agents/codex-rescue.md', rescueAgent],
    ['skills/codex-cli-runtime/SKILL.md', rescueRuntime],
  ] as const) {
    assert.doesNotMatch(source, /return nothing/i, file);
    assert.match(source, /\/stereo:setup/, file);
  }

  for (const file of [
    'adversarial-reviewer.md',
    'implementation-reviewer.md',
    'plan-reviewer.md',
    'planner.md',
    'reviewer.md',
  ]) {
    assert.match(
      read(path.join('agents', file)),
      /^tools:\s*Read, Glob, Grep, Bash, WebFetch, WebSearch$/m,
      file,
    );
  }

  for (const file of expectedAgents.filter((file) => file !== 'codex-rescue.md')) {
    const source = read(path.join('agents', file));
    assert.match(source, /^model:\s*inherit$/m, file);
    assert.match(source, /run_in_background: false/, file);
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
  assert.match(source, /stop-review-gate-hook\.cjs/);
  assert.match(source, /session-lifecycle-hook\.cjs/);

  const hooks = JSON.parse(source) as {
    hooks: {
      SessionStart: Array<{ hooks?: Array<{ timeout: number }> }>;
      SessionEnd: Array<{ hooks?: Array<{ timeout: number }> }>;
    };
  };
  const sessionStart = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks ?? [])[0];
  const sessionEnd = hooks.hooks.SessionEnd.flatMap((entry) => entry.hooks ?? [])[0];
  assert.ok(sessionStart);
  assert.ok(sessionEnd);
  assert.equal(sessionStart.timeout, 5);
  assert.equal(typeof sessionEnd.timeout, 'number');
  assert.equal(SESSION_END_BUDGET_MS + 5000 <= sessionEnd.timeout * 1000, true);
});
