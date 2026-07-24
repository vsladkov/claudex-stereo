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

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.ts" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.ts" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/stereo:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
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

test("plan command drafts a Claude plan and loops Codex plan reviews until approval", () => {
  const source = read("commands/plan.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools:\s*Read, Glob, Grep, Bash\(node:\*\), Bash\(git:\*\), AskUserQuestion/);
  assert.match(source, /--max-plan-rounds <n>/);
  assert.match(source, /plan-review --background --json --round 1/);
  assert.match(source, /<<'CODEX_PAIR_PLAN'/);
  assert.match(source, /status <jobId> --wait --timeout-ms 540000 --json/);
  assert.match(source, /result <jobId> --json/);
  assert.match(source, /plan-review --background --json --thread <threadId> --round <n>/);
  assert.match(source, /`sol` \(mapped to `gpt-5\.6-sol`\) at `max` effort/);
  assert.match(source, /other models default to `xhigh`/i);
  assert.match(source, /applies only at the user-decision points defined below/i);
  assert.match(source, /act on Codex's findings and revise the plan without asking/i);
  assert.match(source, /## Reviewer responses/);
  assert.match(source, /Never run `plan-review` in the foreground/i);
  assert.match(source, /safeguards, not caps/i);
  assert.match(source, /re-raises substantially the same finding a third time/i);
  assert.match(source, /Descope it:/);
  assert.match(source, /the cap defaults to 6/i);
  assert.match(source, /Split the plan \(Recommended\)/);
  assert.match(source, /residual_risks/);
  assert.match(source, /accreting scope instead of converging/i);
  assert.match(source, /Never start implementing from this command/i);
  assert.match(source, /run `\/stereo:implement`/i);
  assert.match(source, /\/stereo:setup/);
  assert.match(readme, /### `\/stereo:plan`/);
  assert.match(readme, /### `\/stereo:implement`/);
  assert.match(readme, /gpt-5\.6-sol/);
  assert.match(readme, /capped at 6 rounds by default/i);
  assert.match(readme, /fix loop is capped at 4 rounds by default/i);
  assert.match(readme, /residual_risks|residualRisks/);
  assert.match(readme, /### Write runs and thread safety/i);
  assert.match(readme, /verify the effective sandbox when resuming a thread/i);
  assert.match(readme, /retries once on a private runtime/i);
  assert.match(readme, /plugin-owned shared runtime is drained only when it is idle/i);
  assert.match(readme, /busy or externally owned runtimes are left alone/i);
  assert.match(readme, /already being used by another Codex run \(job \.\.\.\)/i);
  assert.match(readme, /Reservations are global to `CODEX_HOME`/i);
  assert.match(readme, /cancel a conflicting job from another repository in its own workspace or session/i);
  assert.match(readme, /appears to have crashed while reserving/i);
  assert.match(readme, /Delete the exact lock file named in the error/i);
  assert.match(readme, /Reservation cleanup is already in progress/i);
  assert.match(readme, /run `\/stereo:setup` for the state-correct remedy/i);
  assert.match(readme, /Do not delete both files blindly/i);
  assert.match(readme, /unreadable reservation should be inspected before deleting/i);
  assert.match(readme, /`\/stereo:setup` and `\/stereo:status` list stranded reservations/i);
  assert.match(readme, /write-capable run reported no file changes/i);
  assert.match(readme, /write-sandbox line/i);
});

test("implement command runs Codex implementation and Claude review rounds from the stored plan", () => {
  const source = read("commands/implement.md");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools:\s*Read, Glob, Grep, Bash\(node:\*\), Bash\(git:\*\), AskUserQuestion/);
  assert.match(source, /--max-fix-rounds <n>/);
  assert.match(source, /plan-state --json/);
  assert.match(source, /Run \/stereo:plan first \(Recommended\)/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(source, /git rev-parse HEAD/);
  assert.match(source, /Stop so I can commit or stash first \(Recommended\)/);
  assert.match(source, /task --background --json --write --thread <threadId>/);
  assert.match(source, /<<'CODEX_PAIR_IMPL'/);
  assert.match(source, /<<'CODEX_PAIR_FIX'/);
  assert.match(source, /status <jobId> --wait --timeout-ms 540000 --json/);
  assert.match(source, /task --background --json --write --fresh/);
  assert.match(source, /same issue survives three fix rounds/i);
  assert.match(source, /safeguards, not caps/i);
  assert.match(source, /defaulting to 4 when absent/i);
  assert.match(source, /residualRisks/);
  assert.match(source, /Never commit\. Never push\./);
  assert.match(source, /codex resume <threadId>/);
  assert.match(source, /\/stereo:setup --disable-review-gate/);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(stereo:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `stereo:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "stereo:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(stereo:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `stereo:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(readme, /`stereo:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/stereo:setup`/);
  assert.match(readme, /### `\/stereo:review`/);
  assert.match(readme, /### `\/stereo:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/stereo:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/stereo:rescue`/);
  assert.match(readme, /### `\/stereo:transfer`/);
  assert.match(readme, /### `\/stereo:status`/);
  assert.match(readme, /### `\/stereo:result`/);
  assert.match(readme, /### `\/stereo:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.ts" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.ts" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.ts" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.ts" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.ts/);
  assert.match(source, /session-lifecycle-hook\.ts/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.ts" setup --json \$ARGUMENTS/);
  assert.match(setup, /Always preserve stranded-reservation next steps with their exact file paths/i);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/stereo:setup --enable-review-gate/);
  assert.match(readme, /\/stereo:setup --disable-review-gate/);
});

test("status command documents verbose arguments and presentation", () => {
  const status = read("commands/status.md");

  assert.match(status, /argument-hint:.*--verbose/);
  assert.match(status, /When the user passed `--verbose`, do not compress.*single compact table/i);
  assert.match(status, /log paths, timestamps, and progress/i);
  assert.match(status, /Always preserve any `Warnings:` section and its file paths verbatim/i);
  assert.match(status, /except for a `Warnings:` section from the command output/i);
});
