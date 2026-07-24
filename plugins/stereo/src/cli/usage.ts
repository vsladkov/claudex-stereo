export function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|sol|terra|luna>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|sol|terra|luna>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh|--thread <id>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/codex-companion.mjs plan-review [--background] [--thread <id>] [--round <n>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--plan-file <path>] [plan text]",
      "  node scripts/codex-companion.mjs plan-state [--json]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--verbose] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}
