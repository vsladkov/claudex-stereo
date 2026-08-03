export function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  node scripts/codex-companion.ts config [--planner <selection>] [--planner-effort <effort>] [--plan-reviewer <selection>] [--plan-reviewer-effort <effort>] [--implementer <selection>] [--implementer-effort <effort>] [--implementation-reviewer <selection>] [--implementation-reviewer-effort <effort>] [--clear <key>]... [--json]',
      '  node scripts/codex-companion.ts setup [--enable-review-gate|--disable-review-gate] [--json]',
      '  node scripts/codex-companion.ts doctor [--reset-job-announcements] [--json]',
      '  node scripts/codex-companion.ts review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model-or-alias>]',
      '  node scripts/codex-companion.ts adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [focus text]',
      '  node scripts/codex-companion.ts task [--background] [--write] [--resume-last|--resume|--fresh|--thread <id>] [--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--output-schema <path>] [--prompt-file <path>] [prompt]',
      '  node scripts/codex-companion.ts plan-review [--background] [--thread <id>] [--round <n>] [--slot <name>] [--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--plan-file <path>] [plan text]',
      '  node scripts/codex-companion.ts plan-state [--list|--open|--clear|--mark-implemented] [--slot <name>] [--json]',
      '  node scripts/codex-companion.ts plan-store --verdict <value> [--round <n>] [--slot <name>] [--thread <id>|--no-thread] [--reviewed-by <label>] [--summary <text>|--summary-file <path>] [--findings-file <path>] [--open-question <text>]...|[--open-questions-file <path>] [--residual-risk <text>]...|[--residual-risks-file <path>] [--json] < plan.md',
      '  node scripts/codex-companion.ts implement-state [--record|--update|--complete|--clear] [--state-file <path>] [--slot <name>] [--json]',
      '  node scripts/codex-companion.ts tournament-state [--record|--update|--complete|--clear] [--state-file <path>] [--slot <name>] [--json]',
      '  node scripts/codex-companion.ts transfer [--source <claude-jsonl>] [--json]',
      '  node scripts/codex-companion.ts status [job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--usage] [--verbose] [--json]',
      '  node scripts/codex-companion.ts result [job-id] [--report] [--json]',
      '  node scripts/codex-companion.ts cancel [job-id] [--json]',
      '  node scripts/codex-companion.ts version [--json]',
    ].join('\n'),
  );
}
