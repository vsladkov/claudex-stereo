import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAllowRule } from '../plugins/stereo/src/cli/allow-rules.ts';
import type { ClaudeRole } from '../plugins/stereo/src/runtime/role-agents.ts';

const READ_ONLY_ROLES: readonly ClaudeRole[] = [
  'planner',
  'plan-reviewer',
  'implementation-reviewer',
  'reviewer',
  'adversarial-reviewer',
];

function refusal(rule: string, role: ClaudeRole = 'reviewer'): string {
  try {
    assertAllowRule(rule, role);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

test('a read-only role refuses wildcards', () => {
  for (const rule of ['Bash(eslint:*)', 'Bash(tsc:*)', 'Bash(npm test *)', 'Bash(*)']) {
    for (const role of READ_ONLY_ROLES) {
      assert.match(refusal(rule, role), /^Unsupported --allow rule /, `${rule} for ${role}`);
    }
  }
});

test('a read-only role takes any exact command the orchestrator names', () => {
  // The companion checks only the rule's shape; which commands to grant is the
  // orchestrator's choice, and a grant is matched exactly by Claude Code.
  for (const rule of [
    'Bash(npm test)',
    'Bash(npm run format:check)',
    'Bash(npx tsc --noEmit)',
    'Bash(python3 -m pytest tests/unit)',
    'Bash(cargo test)',
    'Bash(dotnet test)',
    'Bash(git status)',
    'Bash(CI=1 npm test)',
    'Bash(ls ~)',
  ]) {
    for (const role of READ_ONLY_ROLES) {
      assert.doesNotThrow(() => assertAllowRule(rule, role), `${rule} for ${role}`);
    }
  }
});

test('the wildcard refusal names why, with the role that asked', () => {
  for (const role of ['reviewer', 'planner'] as const) {
    assert.equal(
      refusal('Bash(node:*)', role),
      `Unsupported --allow rule "Bash(node:*)": a wildcard would let the read-only ${role} run commands beyond the one named; name the exact command instead.`,
    );
  }
});

test('every role takes one plain Bash command and nothing else, a bare tool name included', () => {
  const shape = 'a rule is Bash(<command>), naming one plain command';
  const plain =
    'a Bash rule names one plain command, without quotes, backticks, $, ;, |, &, <, >, backslashes, parentheses, or newlines';
  for (const [rule, reason] of [
    ['Bash', shape],
    ['Read', shape],
    ['Write', shape],
    ['Read(src/**)', shape],
    ['Bash()', 'the Bash command is empty'],
    ['Bash(git log; rm -rf .)', `the command contains ";"; ${plain}`],
    ['Bash(echo $HOME)', `the command contains "$"; ${plain}`],
    ['Bash(cat a | sh)', `the command contains "|"; ${plain}`],
    ['Bash(echo "x")', `the command contains "\\""; ${plain}`],
    ['Bash(echo `id`)', `the command contains "\`"; ${plain}`],
    ['Bash(echo a\nb)', `the command contains "\\n"; ${plain}`],
    ['Bash(sh -c (id))', `the command contains "("; ${plain}`],
  ] as const) {
    for (const role of [...READ_ONLY_ROLES, 'implementer'] as const) {
      assert.throws(
        () => assertAllowRule(rule, role),
        new Error(`Unsupported --allow rule "${rule}": ${reason}.`),
        `${rule} for ${role}`,
      );
    }
  }
});

test('the implementer keeps its grants: only the plain-command shape is checked', () => {
  for (const rule of [
    'Bash(node:*)',
    'Bash(python -c:*)',
    'Bash(npm *)',
    'Bash(git *)',
    'Bash(git checkout .)',
    'Bash(timeout:*)',
    'Bash(*)',
    'Bash(pytest *)',
    'Bash(FOO=1 npm test)',
    'Bash(prettier --write .)',
    'Bash(ls ~)',
  ]) {
    assert.doesNotThrow(() => assertAllowRule(rule, 'implementer'), rule);
  }
});
