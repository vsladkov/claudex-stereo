---
description: Draft an implementation plan with Claude and iterate with Codex plan reviews until Codex approves it
argument-hint: '[--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-plan-rounds <n>] [task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run the planning half of the dual-model pair workflow through the shared plugin runtime.
You (Claude) draft the implementation plan; Codex adversarially reviews it until it returns an `approve` verdict.
Implementation is a separate step: the user starts it later with `/stereo:implement`. Never start implementing from this command.

Raw slash-command arguments:
`$ARGUMENTS`

Scope of the result-handling rules:

- This command is a deliberate, user-invoked iterative workflow.
- Within it, the `codex-result-handling` rule to STOP after presenting findings applies only at the user-decision points defined below.
- Inside the plan-review loop, act on Codex's findings and revise the plan without asking the user.

Argument handling:

- `--model` and `--effort` are runtime-selection flags. Forward them verbatim to every `plan-review` call. If unset, the companion defaults to `sol` (mapped to `gpt-5.6-sol`) at `max` effort; gpt-5.6-family model overrides also default to `max`, other `gpt-*` models default to `xhigh`, and non-OpenAI models omit the effort override.
- `--max-plan-rounds <n>` caps the review loop. If absent, the cap defaults to 6 — healthy loops approve in 2-5 rounds; a plan that cannot converge by then has a scope problem, not a detail problem.
- All remaining text is the task description. If it is empty, ask the user what to plan before doing anything else.

Phase 1 - Draft the plan:

- Explore the repository first with Read, Glob, and Grep until you can name exact files, symbols, and integration points.
- Write a self-contained plan document with exactly these sections: `## Goal`, `## Approach`, `## Files to change`, `## Step-by-step changes`, `## Testing and verification`, `## Risks and edge cases`, `## Out of scope`.
- The plan must stand alone: Codex sees only the plan text plus the repository, never this conversation.
- Keep the plan proportional to the task. If an honest draft needs more than roughly 400 lines, the task is too big for one plan: propose a split to the user before launching round 1. The `## Goal` and `## Out of scope` sections are the review's scope contract - write them precisely, because the reviewer judges the plan against them.
- Do not write the plan into the user's repository. Deliver it to the companion via heredoc stdin with a quoted delimiter so the shell never expands its contents.

Phase 2 - Codex review loop:

- Launch round 1 in the background. Never run `plan-review` in the foreground: long `max` reviews can exceed the Bash timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <<'CODEX_PAIR_PLAN'
<full plan document>
CODEX_PAIR_PLAN
```

- Parse the launch JSON for `jobId`, then poll until the job leaves `queued`/`running`, passing a Bash `timeout` of 120000 for each poll call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 --json
```

- After each non-terminal poll, post a one-line progress note from the payload — the job's `phase`, its elapsed time, and the latest progress line (the last entry of the payload's `job.progressPreview` array; it is empty once a job completes) — then poll again. A healthy run advances through `investigating` to `verifying`; the short windows exist so the user can watch that movement instead of staring at one silent multi-minute call.
- If any launch or poll command prints a top-level `{"error": ...}` JSON object instead of a job payload, surface that error to the user and stop the loop - do not keep polling.
- If the job reports no phase change and no new `job.progressPreview` entry for roughly 10 minutes, treat it as stalled and use `AskUserQuestion` once with `Keep waiting (Recommended)` and `Cancel the review and stop`. Total elapsed time alone is not a stall: keep polling without interruption while phases or progress lines continue to advance.
- When the job finishes, fetch the stored result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --json
```

- Read `storedJob.result`: `.threadId` (save it as the pair thread id), `.model` and `.effort` (the resolved values), `.result.verdict`, `.result.findings`, `.result.revision_instructions`, `.result.open_questions`, `.result.residual_risks`, and `.parseError`.
- Update the saved pair thread id from every round's payload - after a failed-resume retry the thread id changes.
- If `parseError` is set, resubmit the same plan and round once with `--thread <threadId>`. If it fails again, show the raw output and use `AskUserQuestion` with `Stop and treat the plan as unapproved` and `Continue revising anyway`.
- If the job status is `failed`, recover according to the round: for round 1, retry once without `--thread` on a fresh thread; for round >1, retry once on the same `--thread <threadId>`. If that retry also fails, restart the loop as round 1 without the old thread id, carrying the accumulated `## Reviewer responses` inside the full plan text. Surface the error if the fresh round-1 restart still fails.
- On `needs-revision`: address every finding with exactly one of three moves, then resubmit.
  1. Change the plan to fix it.
  2. Rebut it under a `## Reviewer responses` section with concrete evidence.
  3. Descope it: when the fix would add machinery beyond the `## Goal` (a new protocol, subsystem, registry, or lifecycle) or would fix a pre-existing hazard the plan does not create, move it to `## Out of scope` as a documented residual with a suggested follow-up plan, and record the descope in `## Reviewer responses`. Descoping a real problem is a legitimate outcome, not a failure.
- Treat `residual_risks` entries as acknowledged context, never as mandatory fixes: fold the material ones into `## Risks and edge cases`, and carry the list forward for the final report.
- Keep `## Reviewer responses` bounded: full entries for standing rebuttals and the last 5 rounds; compress older accepted entries to one line each. The log is context for the reviewer, not an archive.
- Resubmit the full revised plan on the same thread with the next round number:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <threadId> --round <n> <<'CODEX_PAIR_PLAN'
<full revised plan document>
CODEX_PAIR_PLAN
```

- Forward `--model`/`--effort` on later rounds only if the user overrode them; otherwise the companion re-applies the same defaults.
- On `approve`: the loop is done.
- After each round, post a one-line progress note with the round number, the verdict, and the finding count.

Stall safeguards (these are safeguards, not caps):

- When the round cap (explicit or the default of 6) is reached without approval, stop the loop and present the latest findings with `AskUserQuestion`: `Split the plan (Recommended)`, `Keep iterating`, `Accept the plan as-is`, `Stop here`.
- Scope-accretion trigger: if the plan grows past roughly 1.5x its round-1 size, or a new finding targets machinery that earlier review rounds added rather than the original draft, the loop is accreting scope instead of converging - pause and ask the same question even if rounds remain.
- If Codex re-raises substantially the same finding a third time after two explicit rebuttals with no new evidence, or the plan keeps oscillating between two shapes, pause and ask the same question instead of looping forever.
- If the user chooses to split: keep the original-scope core as this plan (descoping the accreted machinery with documented residuals), finish its review, and present the carved-out topics as named follow-up plan candidates.

Finish:

- Present the approved plan, the final verdict, the number of rounds used, any `open_questions`, and the accumulated `residual_risks` (documented non-blocking residuals and their suggested follow-up plans).
- The companion stores the latest reviewed plan, its Codex thread, and the final round's `open_questions` and `residual_risks` automatically; `/stereo:implement` reads all of it from there.
- Tell the user: run `/stereo:implement` to have Codex implement the approved plan.
- If Codex is missing or unauthenticated at any point, stop and tell the user to run `/stereo:setup`.
