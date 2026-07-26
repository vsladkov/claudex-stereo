---
description: Implement the plan reviewed in /stereo:plan with independently selected Claude or Codex implementation and review models
argument-hint: '[--model <implement-model>] [--review-model <review-model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-fix-rounds <n>] [--fresh]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
---

Run the implementation half of the dual-model pair workflow through the shared plugin runtime.
The main Claude session orchestrates implementation, verification, review, and fixes. The selected
Claude or Codex model performs each routed implementation or review step.

Raw slash-command arguments:
`$ARGUMENTS`

Parse all arguments before loading state or starting an agent or Codex job:

- `--model <model>` selects the implementer. If absent, use the stored Codex model; if the stored
  value is null, use `sol`.
- `--review-model <model>` selects the implementation reviewer and defaults to `claude:session`.
- `--effort <none|minimal|low|medium|high|xhigh|max>` applies only to selected Codex steps. Never
  pass it to a Claude-side step.
- `--max-fix-rounds <n>` defaults to 4.
- `--fresh` skips a reusable stored Codex review thread.
- Reject missing values, duplicate model flags, unexpected positionals, invalid effort, and unknown
  `claude:*` values before work.

Model addressing is role-local:

- `claude:sonnet`, `claude:opus`, `claude:haiku`, and `claude:fable` select the corresponding
  foreground Claude subagent model override.
- `claude:session` is valid only for `--review-model`, where it preserves the existing inline
  review. Reject it for `--model`: Claude implementation must use the contained
  `stereo:implementer` agent.
- Anything not beginning with `claude:` is a Codex model request. Pass aliases, raw ids, and
  qualified `model@provider` values to the companion for `normalizeRequestedModel` resolution.
- For a Codex implementation reviewer, use the pair default effort for the selected model when
  `--effort` is absent: `max` for the gpt-5.6 family, `xhigh` for other `gpt-*` models, and no
  effort override for non-OpenAI models.

Treat user-supplied Codex `--model` and `--effort` implementation values as overrides. Otherwise
use the stored values. When a mixed-flow record has both `model` and `effort` set to null, use the
canonical pair defaults `sol` and `max`; do not pass literal nulls or silently defer to the user's
Codex configuration. When the effective effort is null, omit the `--effort` flag entirely. If the
user overrides `--model` without also passing `--effort`, treat the implementation effort as unset
— the stored effort belonged to the stored model. In the templates below,
`<effortArg>` means the implementation's `--effort <effectiveEffort>` when non-null and nothing
otherwise; `<reviewEffortArg>` is the corresponding reviewer argument. Never pass a
Claude-prefixed value to the companion.

Scope of the result-handling rules:

- This command is a deliberate, user-invoked iterative workflow.
- Within it, the `codex-result-handling` rule to STOP after presenting findings applies only at the user-decision points defined below.
- Inside the fix loop, act on review findings and route fixes to the selected implementer without
  asking the user.

Every Codex turn is launched with `--background --json`; never wait on a long turn in one
foreground Bash call. Parse `jobId`, poll until terminal, post phase/elapsed/latest
`job.progressPreview` updates, then fetch the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --json
```

Surface any top-level `{"error": ...}` or failed job. Treat no phase change and no new progress
entry for roughly 10 minutes as stalled; ask `Keep waiting (Recommended)` or
`Cancel the implementation and stop`. Elapsed time alone is not a stall. If Codex is missing or
unauthenticated, stop and direct the user to `/stereo:setup`.

Phase 0 - Preflight:

- Load the stored plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

- If `available` is `false`, stop and tell the user to run `/stereo:plan` first.
- Save the stored plan's thread id only as `storedPlanReviewThreadId`; it is not
  `implementationThreadId`.
- If `verdict` is not `approve`, use `AskUserQuestion` once with
  `Run /stereo:plan first (Recommended)`, `Implement the unapproved plan anyway`, and `Stop here`.
- Show a one-line recap: plan summary, round count, `updatedAt`, reviewer label when present, and
  whether documented residual risks exist. Mention that `/stereo:plan-state` renders the full
  stored plan.
- Check the worktree with `git status --porcelain=v1 --untracked-files=all`. Record
  `baselineCommit` from `git rev-parse HEAD` plus the exact already-dirty path list.
- If dirty, ask `Stop so I can commit or stash first (Recommended)` or
  `Continue with a dirty worktree`.
- If the stop-time review gate is enabled, mention that finishing triggers one extra Codex review
  and that `/stereo:setup --disable-review-gate` avoids it during long pair sessions.

If the selected implementer is Claude, scan the stored plan's `## Step-by-step changes` before any
edit for command-requiring work beyond the fixed host verification gates: version bumps, package
installation, code generation, migrations, or interactive/long-running processes. If found, ask:

- `Switch this step to a Codex implementer (Recommended)` — select canonical `sol` with the user's
  effort or `max`, then use the Codex branch.
- `Continue with file edits only — the listed command steps become yours to run` — record each
  user-owned step and list it as unexecuted in the final report.
- `Stop here`.

The Claude implementer never requests commands and the orchestrator never executes shell text on
its behalf.

Phase 1 - Implementation routing:

### Codex implementer

When `storedPlanReviewThreadId` is non-null and the user did not pass `--fresh`, resume that
review thread. Otherwise start a fresh thread without `--thread`; this is the continuation path for
plans reviewed outside Codex. Embed the complete stored plan verbatim and use
`<effectiveModel>` and `<effortArg>`.

For a non-null stored thread whose verdict is `approve`, use the canonical resumed-thread prompt:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <storedPlanReviewThreadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier in this thread.

[full stored plan text, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. If a step turns out to be impossible, say so explicitly instead of silently skipping it.
</completeness_contract>
<verification_loop>
Run the repository's relevant tests or build before finalizing and fix what you break.
</verification_loop>
<compact_output_contract>
Report: a summary of the changes, the files you touched, the verification you ran with results, and any deviations from the plan with reasons.
</compact_output_contract>
CODEX_PAIR_IMPL
```

For a non-null stored thread whose verdict is not `approve`, only continue after the Phase 0 user
gate. Use the same resumed command and contracts, but replace the task block with truthful wording:

```text
<task>
Implement the reviewed but unapproved plan below in this repository. You reviewed this plan earlier in this thread, and the user explicitly chose to continue despite its stored verdict.

[full stored plan text, verbatim]
</task>
```

For a null stored thread whose verdict is `approve`, use this truthful fresh-thread prompt. If
`reviewedBy` is present, include `, by <reviewedBy>` in the first sentence; otherwise omit that
phrase.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside this Codex thread<, by reviewedBy when present>.

[full stored plan text, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. If a step turns out to be impossible, say so explicitly instead of silently skipping it.
</completeness_contract>
<verification_loop>
Run the repository's relevant tests or build before finalizing and fix what you break.
</verification_loop>
<compact_output_contract>
Report: a summary of the changes, the files you touched, the verification you ran with results, and any deviations from the plan with reasons.
</compact_output_contract>
CODEX_PAIR_IMPL
```

For a null stored thread whose verdict is not `approve`, only continue after the Phase 0 user gate.
Use the same fresh command and contracts, but replace the task block with truthful wording:

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was reviewed outside this Codex thread<, by reviewedBy when present>, and the user explicitly chose to continue despite its stored verdict.

[full stored plan text, verbatim]
</task>
```

- `--fresh` from the user also skips a non-null stored thread and starts a new one (still embed the
  full plan and pass `--write`, without `--thread`).

Poll and fetch through the common background-job handling. If resume fails, or Codex claims
changes while both `touchedFiles` and the delta are empty, retry once fresh with the identical full
prompt. Adopt the latest implementation payload's thread id only as `implementationThreadId`.

### Claude implementer

Invoke the contained agent in the foreground:

```text
subagent_type: "stereo:implementer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Apply only the file edits in this plan. Never request command execution.

  [full stored plan text, verbatim]

  Baseline dirty paths to preserve:
  [path list]
```

An Agent/model availability error stops the selected step; never silently substitute another
model. Immediately after every Claude implementation or fix invocation:

- Compare `git rev-parse HEAD` with `baselineCommit`.
- If HEAD moved, stop, surface the change, and mark the final never-commit statement as retracted.
- Inspect `git diff <baselineCommit>`, status, and every new file while excluding baseline-dirty
  paths from attribution.

After either implementer, the orchestrator runs the identifiable repository checks on the host.
For this repository, use `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
and `npm run check-version`; elsewhere, use documented equivalents. Record every command and exit
result. These fixed verification gates are orchestrator-owned, not model-requested shell work.

Phase 2 - Implementation review router and fix loop:

Build review input from the full stored plan, `baselineCommit`, baseline-dirty paths, current
status/diff, changed and untracked files, implementer report, and host-check results.

Route every review by `--review-model`:

- `claude:session`: preserve the existing inline review:
  - Inspect `git status --short --untracked-files=all`, `git diff`, and every changed or untracked
    file, ignoring paths already dirty in the baseline.
  - Run the project's identifiable test suite or build.
  - Check the implementation against every plan step and earlier review finding.
  - Produce internal `{acceptable, summary, fixes}` data. Each fix names file and line, what is
    wrong, and what correct looks like.
- A named Claude model: invoke the reviewer in the foreground:

```text
subagent_type: "stereo:implementation-reviewer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Review this implementation against the plan and baseline. Inspect git status/diff and run only
  the named verification commands. Return only raw JSON.

  Plan:
  [full stored plan verbatim]

  Baseline commit and already-dirty paths:
  [baseline data]

  Host verification:
  [commands and results]
```

- A Codex model: start a fresh read-only task. Save its id only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> <<'CODEX_PAIR_PLAN'
<task>
Review the current implementation delta against the complete plan below.
Inspect git status and git diff relative to the supplied baseline, ignore already-dirty paths, and
run the named verification commands. Do not edit files.

Plan:
[full stored plan verbatim]

Baseline commit:
[baselineCommit]

Already-dirty paths:
[path list]

Host verification results:
[commands and results]
</task>
<output_contract>
Return only this raw JSON shape:
{"acceptable":boolean,"summary":"non-empty string","fixes":[{"file":"path","line":1,"problem":"what is wrong","correct":"correct result"}]}
When acceptable is true, fixes must be empty. Otherwise fixes must be non-empty.
</output_contract>
CODEX_PAIR_PLAN
```

Parse named-Claude output directly and Codex output from `storedJob.result.rawOutput`. Validate
`acceptable`, a non-empty `summary`, `fixes`, and every non-empty `file`, positive-integer `line`,
non-empty `problem`, and non-empty `correct`. Retry malformed output once with the exact validation
error. A Claude retry is a new foreground call with `run_in_background: false`; a Codex retry is
read-only on `--thread <implementationReviewThreadId>`. The retry may update only
`implementationReviewThreadId`; it must never overwrite `implementationThreadId`. After a second
failure ask `Let the orchestrator review inline (Recommended)` or `Stop here`; never infer a
verdict.

If acceptable, finish. Otherwise send the exact numbered fixes to the same implementer kind that
produced the delta.

For Codex fixes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_FIX'
<task>
Fix the review findings below in this repository. Keep all other behavior unchanged.

[numbered fixes with file, line, problem, and correct result]
</task>
<verification_loop>
Run the repository's relevant tests or build before finalizing and fix what you break.
</verification_loop>
<compact_output_contract>
Report which findings you fixed, how, and what verification you ran.
</compact_output_contract>
CODEX_PAIR_FIX
```

For Claude fixes, invoke `stereo:implementer` with the original Claude model override,
`run_in_background: false`, the full plan, and the numbered fixes verbatim. Recompare
`git rev-parse HEAD` with `baselineCommit` and re-inspect the baseline delta immediately afterward.

After every fix, rerun the host checks and the selected reviewer. Adopt
`implementationThreadId` exclusively from Codex implementation/fix payloads. Never assign
`implementationReviewThreadId` to it.

Stall safeguards (these are safeguards, not caps):

- At `--max-fix-rounds` (default 4), present remaining fixes and ask
  `Send one more implementer round`, `Let the orchestrator fix the rest directly`, or
  `Stop and report as-is`.
- If substantially the same issue survives 3 rounds, pause and ask the same question early.

Final report:

- Summarize the selected implementer and reviewer, fix rounds used, attributed files, host
  verification results, deviations, user-owned unexecuted command steps, and all stored
  `openQuestions` and `residualRisks`.
- When Codex implemented, include `implementationThreadId` and
  `codex resume <implementationThreadId>`.
- Label `storedPlanReviewThreadId` and `implementationReviewThreadId` by role when present; never
  present either review-only id as the implementation resume target.
- Give rollback guidance relative to `baselineCommit`, preserving paths dirty before this run.
- If HEAD is still `baselineCommit`, state plainly that nothing was committed or pushed. If HEAD
  moved at any point, retract that claim explicitly and report the observed commit change.
- Never commit. Never push.
