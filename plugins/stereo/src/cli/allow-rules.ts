// `--allow` permission rules for headless Claude roles. A rule is
// `Bash(<command>)` naming one plain command, which Claude Code matches
// exactly. The orchestrator chooses the commands (the plan's verification
// commands and its own gates); the companion checks only their shape. A grant
// is not containment: a granted test command runs whatever the project's
// tests and scripts do.

import { roleWrites } from '../runtime/index.ts';
import type { ClaudeRole } from '../runtime/role-agents.ts';

const ALLOW_FORBIDDEN = /["'`$;|&<>\\()\r\n]/;

// A `--allow` rule is `Bash(<command>)` with one plain command: no quoting,
// expansion, chaining, redirection, or grouping, so a rule means exactly what
// it reads as. A bare tool name is no rule (a bare `Bash` would grant the
// whole shell). Every role but the implementer is read-only and names exact
// commands (no wildcard); the implementer's rule may contain `*`.
export function assertAllowRule(rule: string, role: ClaudeRole | null): void {
  const refuse = (reason: string): never => {
    throw new Error(`Unsupported --allow rule "${rule}": ${reason}.`);
  };
  if (!rule.startsWith('Bash(') || !rule.endsWith(')')) {
    refuse('a rule is Bash(<command>), naming one plain command');
  }
  const command = rule.slice('Bash('.length, -1).trim();
  if (!command) {
    refuse('the Bash command is empty');
  }
  const forbidden = ALLOW_FORBIDDEN.exec(command);
  if (forbidden) {
    refuse(
      `the command contains ${JSON.stringify(forbidden[0])}; a Bash rule names one plain command, without quotes, backticks, $, ;, |, &, <, >, backslashes, parentheses, or newlines`,
    );
  }
  if (!roleWrites(role) && command.includes('*')) {
    refuse(
      `a wildcard would let the read-only ${role ?? 'role'} run commands beyond the one named; name the exact command instead`,
    );
  }
}
