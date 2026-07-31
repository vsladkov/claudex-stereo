export function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  node scripts/codex-companion.ts setup [--enable-review-gate|--disable-review-gate] [--json]',
      '  node scripts/codex-companion.ts review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model-or-alias>]',
      '  node scripts/codex-companion.ts adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model-or-alias>] [focus text]',
      '  node scripts/codex-companion.ts task [--background] [--write] [--resume-last|--resume|--fresh|--thread <id>] [--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--output-schema <path>] [--prompt-file <path>] [prompt]',
      '  node scripts/codex-companion.ts plan-review [--background] [--thread <id>] [--round <n>] [--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--plan-file <path>] [plan text]',
      '  node scripts/codex-companion.ts plan-state [--open] [--json]',
      '  node scripts/codex-companion.ts plan-store --verdict <value> [--round <n>] [--thread <id>|--no-thread] [--reviewed-by <label>] [--summary <text>] [--findings-file <path>] [--open-question <text>]... [--residual-risk <text>]... [--json] < plan.md',
      '  node scripts/codex-companion.ts transfer [--source <claude-jsonl>] [--json]',
      '  node scripts/codex-companion.ts status [job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--verbose] [--json]',
      '  node scripts/codex-companion.ts result [job-id] [--json]',
      '  node scripts/codex-companion.ts cancel [job-id] [--json]',
    ].join('\n'),
  );
}
