---
description: Run one approved plan through parallel Codex implementers in isolated worktrees and hand back the winning delta
argument-hint: '[--implementer <model>]... [--implementer-effort <none|minimal|low|medium|high|xhigh|max>]... [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--slot <name>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(npm:*), Bash(git:*), AskUserQuestion, Agent
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md` and apply its routing, foreground
agent, validation, quoting, and background-job rules. The rules below are step-specific.

Run one stored plan through independent Codex implementers in parallel isolated worktrees. The main
Claude session owns preflight, containment, evidence collection, independent reviews, user
selection, hand-back, cleanup, and final verification.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments

After reading the routing skill, parse all arguments before loading state:

- `--implementer <model>` is repeatable. Declaration order defines contestant labels `c1`, `c2`,
  and `c3`; duplicate models are legal and produce independent samples of the same model. Require
  exactly 2 or 3 occurrences. With one, stop and name `/stereo:implement` as the
  single-implementer command. With four or more, stop and state that tournaments are capped at 3
  contestants.
- Every contestant must be Codex-routed. Reject every `claude:*` value, including
  `claude:session` and `claude:inherit`: Claude implementers are foreground-only, cannot run
  concurrently, and their worktree writes may be denied outside the main workspace. Accept a
  Codex selection with or without the `codex:` prefix and reject `codex:claude:*`.
- `--implementer-effort <none|minimal|low|medium|high|xhigh|max>` is repeatable. It is legal only
  when absent entirely or supplied exactly as many times as `--implementer`; the k-th effort pairs
  with the k-th contestant. Reject a partial list and name the exact implementer and effort counts
  seen.
- `--implementation-reviewer <model>` selects one shared implementation reviewer. Accept it once
  and resolve it as explicit flag > workspace `implementationReviewer` default > `claude:fable`.
  `claude:session` is legal for this role.
- `--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort
  for a Codex-routed reviewer and is illegal for a Claude-routed reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for Codex roles
  without a role effort flag.
- `--slot <name>` selects the stored plan slot and defaults to `default`. Define `<slotArg>` as
  `--slot <slot>` for a non-default slot and omit it entirely for `default`.

Reject missing values, duplicate single-occurrence flags, invalid efforts, positionals, unknown
flags, unknown `claude:*` reviewer values, and `codex:claude:*` before repository work. Resolve each
contestant's effective effort as its paired `--implementer-effort`, then command-wide `--effort`,
then the valid workspace implementer effort, then the routing skill's model-pair default. Resolve a
Codex reviewer's effort as `--implementation-reviewer-effort`, then command-wide `--effort`, then
the valid workspace implementation-reviewer effort, then the model-pair default. Omit a null
effort argument.

Reject these `/stereo:implement` mode flags here:

- Reject `--isolated` and explain that tournament isolation is unconditional.
- Reject `--resume`, `--implement-only`, `--review-only`, `--base`, `--max-fix-rounds`, and
  `--fresh`, naming `/stereo:implement` as their supported home.
- Explain that `--fresh` is unnecessary: contestants always start fresh write threads and never
  resume a stored plan-review thread. Sharing that thread would couple contestants that must stay
  independent.

## Workspace role defaults

Before the stored-plan preflight, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --json
```

Read `roleDefaults`. If the command fails, report the failure and continue with built-in defaults.
Ignore any entry with a non-null `invalidReason`, report its warning, and use the built-in default
for that role. Report a Claude-routed stored effort as inert. Resolve stored `claude:*` selections
as Claude routes and never pass them to the companion's `--model` flag.

The workspace `implementer` model supplies no contestant: every contestant is explicit. Its valid
effort may still participate in the effort ladder above. The workspace `implementationReviewer`
entry participates normally in reviewer model and effort resolution. State the final effective
model and effort for every contestant and the reviewer before launching anything.

## Preflight

1. Load the selected stored plan:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
   ```

   If `available` is false, run `plan-state --list --json`. Name every populated slot when any
   exist; otherwise stop and direct the user to `/stereo:plan`. Retain the complete plan and retain
   `findings` as `storedPlanFindings`, treating a missing or non-array value as empty. Ignore every
   stored plan-review thread id entirely: contestants always receive fresh independent threads.

2. If the stored verdict is not `approve`, show its verdict, round (including round 0), `updatedAt`,
   reviewer label when present, residual-risk status, finding count, and `implementedAt` when
   present, then ask exactly once:
   - `Run /stereo:plan first (Recommended)`
   - `Run the tournament on the unapproved plan anyway`
   - `Stop here`

   If the verdict is `approve` but `implementedAt` is present, report the marker in the stored-plan
   summary without treating it as permission to skip any tournament step.

3. Inspect the workspace implementation record without changing it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --json
   ```

   If a record exists with `status: in-progress`, report its baseline, round, and worktree when it
   is isolated. Ask exactly once whether to continue anyway or stop, explaining that hand-back into
   a tree with a live implementation phase makes attribution ambiguous. The tournament never
   writes, updates, completes, or clears this record.

4. Set `<mainRoot>` from `git rev-parse --show-toplevel`, `baselineCommit` from
   `git rev-parse HEAD`, and `baselineDirty` from the exact path set in
   `git status --porcelain=v1 --untracked-files=all`. If dirty, explain that every contestant starts
   from `HEAD` and lacks those changes, and that hand-back refuses to patch paths overlapping the
   currently dirty set. Ask exactly once whether to stop and commit or stash first (recommended) or
   continue. If the stop-time review gate is enabled, mention that it reviews the main tree, which
   remains clean during the run, and point to `/stereo:setup --disable-review-gate`.
5. State explicitly before launch that the tournament never marks the plan implemented, never
   writes durable tournament or implementation state, and never commits or pushes.

## Worktrees

For each contestant in order, derive `<repoSlug>` from the basename of `<mainRoot>` by replacing
every run of characters outside `[A-Za-z0-9._-]` with `-`. Generate a fresh unique `<shortId>` and
create a detached worktree only outside `<mainRoot>`:

```bash
git -C "<mainRoot>" worktree add --detach "${TMPDIR:-/tmp}/stereo-worktrees/<repoSlug>-<shortId>" HEAD
```

Save the resulting absolute path as that contestant's `<worktreePath>`. Never place a tournament
worktree inside `<mainRoot>`. If any creation fails, remove every worktree already created with
`git -C "<mainRoot>" worktree remove --force "<worktreePath>"`, report the exact creation or cleanup
failure, and stop without launching a contestant.

For each contestant define `<isolationArgs>` as:

```text
--cwd "<worktreePath>" --workspace "<mainRoot>"
```

`--cwd` sets that Codex thread's cwd and confines its writes to the detached worktree. `--workspace`
keeps the job record, log, durable job state, and shared broker keyed to the main workspace. Thus
`/stereo:status`, `/stereo:result`, and `/stereo:cancel` see every contestant from the main
repository and no worktree-keyed broker is started.

## Launching contestants

Use the Write tool and the routing skill's temporary-directory rule to create one distinct
`<payloadFile>` per contestant outside both repository trees. For an approved plan, write this
complete payload with that contestant's values:

```text
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside
this Codex thread<, by reviewedBy when present>.

[full stored plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]

The working root for this task is <worktreePath>, a detached worktree at <baselineCommit>. Do not
modify any other directory.
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. Report any impossible step explicitly.
</completeness_contract>
<verification_loop>
Run the repository's relevant tests or build and fix regressions when their dependencies are
present in this worktree. This worktree is a fresh checkout, so gitignored dependencies and
generated artifacts may be absent; if a gate cannot run, say so explicitly and never report
unverified work as verified.
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification results, and deviations with reasons.
</compact_output_contract>
```

Include the advisory block only when `storedPlanFindings` is non-empty. It never authorizes work
outside the approved plan.

For an unapproved plan whose preflight gate the user chose to pass, replace only the task block
above with this variant and retain all four contracts unchanged:

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was reviewed
outside this Codex thread<, by reviewedBy when present>, and the user explicitly chose to
continue despite its stored verdict.
Implement only the plan's scope and do not silently discard the known findings.

[full stored plan, verbatim]

Latest stored review findings:
[stored findings, verbatim]

The working root for this task is <worktreePath>, a detached worktree at <baselineCommit>. Do not
modify any other directory.
</task>
```

Include the latest-findings block only when `storedPlanFindings` is non-empty. Launch each
contestant with this canonical line, parsing and saving its `jobId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <contestantModel> <contestantEffortArg> <isolationArgs> --prompt-file "<payloadFile>"
```

Launch contestants strictly in label order. Immediately after each launch, run exactly one
flagless instant status call, never `--wait` and never a loop, report its phase, and only then
launch the next contestant:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId>
```

The shared workspace broker serializes turns, so the first contestant holds its turn slot and
later contestants deterministically fall back to a private Codex runtime, while interleaved setup
requests can still produce a transient busy rejection.

If a contestant reaches `failed` with an error saying the shared Codex broker is busy, relaunch it
exactly once with the identical payload file, worktree, model, and effort flags; run the same one
instant status call, and replace its old job id with the new one. Never retry that condition again.
Any other failed job, a second busy failure, or a cancelled job withdraws the contestant with its
exact status and error. A withdrawn contestant is any terminal non-completed job after this rule.
It is excluded from evidence review and selection, but its worktree is retained and reported with
the exact removal command so partial work is never destroyed. Continue with the remaining jobs and
stop after containment only if no contestant completes successfully.

## Waiting and containment

Rotate through all non-terminal contestants and poll each through the routing skill's bounded
window command until every job is terminal:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 | grep -E 'Phase|Elapsed|^ {4}'
```

Between non-terminal polls, report that contestant's phase, elapsed time, and last progress entry.
Apply the routing skill's empty/nonzero poll recovery and stall question separately to every job.
For each completed prose-report job fetch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --report --json
```

Save `report`, `threadId`, and `tokenUsage`; record `storedJob.tokenUsage.job` as per-invocation
usage and use `usage unavailable` when omitted. Apply the relaunch-once rule above if a terminal
result reveals the qualifying busy failure.

After every contestant is terminal, run the containment guard exactly once:

```bash
git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all
```

Compare its exact path set with `baselineDirty`. Any new main-tree path means an implementer wrote
outside its worktree. Concurrent execution makes attribution impossible: stop the whole tournament,
report the paths verbatim, hand back nothing, remove no worktree, and list every worktree path plus
its exact removal command. Codex-reported `touchedFiles` are absolute to a worktree and are not
main-tree writes.

## Evidence

For each completed contestant, create a recovery patch and collect comparison evidence in its
worktree:

```bash
git -C "<worktreePath>" add -N .
git -C "<worktreePath>" diff --binary --no-ext-diff "<baselineCommit>" > "<patchFile>"
git -C "<worktreePath>" diff --stat "<baselineCommit>"
git -C "<worktreePath>" diff --name-only "<baselineCommit>"
```

Create `<patchFile>` under the routing skill's temporary-directory rule, never inside either tree.
It preserves every completed contestant's full delta after a losing worktree is removed. Report a
contestant with an empty patch as producing no delta and exclude it from review and selection. If
every completed contestant is empty, report that result, remove all completed contestants'
worktrees, print every patch path, retain and report any withdrawn contestant worktrees, and stop.

Detect byte-identical patch files and say so in the comparison instead of implying their deltas
differ.

Do not run host gates per contestant. Fresh worktrees commonly lack gitignored dependencies and
generated artifacts, and paying the full suite cost for every candidate is not useful when the
isolated result would only say `not runnable in the isolated worktree`. For every contestant set
`{{HOST_RESULTS}}` to: host verification was not run in this worktree, and the reviewer must not
treat the delta as verified. Run the complete gate set once in the main tree only after a confirmed
hand-back.

## Per-contestant implementation review

Review every non-empty completed contestant exactly once, strictly sequentially in contestant
order. Read `${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md` and fill it for that contestant
without changing any other text:

- `{{PLAN_INPUT}}` = the full stored plan.
- `{{BASELINE_CONTEXT}}` = state that the delta lives in the isolated worktree at
  `<worktreePath>` at `<baselineCommit>`; include the diffstat, changed-file list, and complete
  diff; state that fix `file` values remain repository-relative and identical in both trees; and
  state that the main tree is not the review target.
- `{{REVIEW_CONTEXT}}` = state that this is a single-round tournament review of one contestant's
  delta, that there are no earlier implementation-review rounds, and that no fixes will be
  applied. Include the contestant's implementer report verbatim. Include `storedPlanFindings`
  verbatim when non-empty, labeled advisory when the stored verdict is `approve` and as known
  unapproved findings otherwise.
- `{{HOST_RESULTS}}` = the not-run statement in **Evidence**.

The filled result is that contestant's `implementationReviewBrief`. Route it through the one
selected reviewer:

- For `claude:session`, apply the complete brief inline.
- For a named Claude selection, use the routing skill's foreground template:

  ```text
  subagent_type: "stereo:implementation-reviewer"
  model: "<sonnet|opus|haiku|fable>"
  run_in_background: false
  prompt: |
    [complete implementationReviewBrief]
  ```

  For `claude:inherit`, omit the `model` parameter entirely. Record the Agent result's
  per-invocation usage and duration, or `usage unavailable` for either omitted metric.

- For a Codex reviewer, write the complete brief to that contestant's review payload file under
  the routing skill's temporary-directory rule and launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" <isolationArgs> --prompt-file "<payloadFile>"
```

Poll and fetch a Codex review through the routing skill, save its `threadId`, duration, and
`storedJob.tokenUsage.job`, and use `usage unavailable` for omitted metrics. Validate every route's
`acceptable`, non-empty `summary`, and `fixes`; validate each fix's required fields and enforce the
acceptable/fixes coupling. Retry malformed output once for that contestant using the same selected
reviewer and the routing skill's retry rules. Never infer a verdict after an exhausted retry; record
the validation error and follow the routing skill's ask-once choice to perform only that
contestant's review inline or stop. Validate an inline result through the same contract before
continuing. A selected-model or Agent-tool availability failure follows the routing skill's
immediate-stop rule and keeps all remaining worktrees and patches.

Never continue one reviewer across contestants, and never mention one contestant's delta or verdict
to another's reviewer. Every contestant gets a fresh Agent invocation, inline assessment, or Codex
task.

For a named-Claude or `claude:session` reviewer, supply the absolute worktree path and require
`git -C "<worktreePath>"` plus absolute Read paths. If the harness denies reads outside the main
workspace, fall back to the complete diff already embedded in `{{BASELINE_CONTEXT}}` and record
that limitation for the contestant.

## Selection

Present one comparison-table row per non-empty completed contestant. Include:

- label; `codex:`-prefixed model and effective effort; implementation job id and thread id
- files changed and total insertions/deletions
- review `acceptable`, fix count, and summary
- reported deviations
- per-invocation usage and duration for both implementer and reviewer turns

For Codex use `storedJob.tokenUsage.job`; for named Claude use the Agent result. Print
`usage unavailable` rather than omitting an unavailable metric. State beside the table that no
candidate has passed host gates. Also flag byte-identical deltas.

Use `AskUserQuestion` exactly once with one option per selectable contestant plus
`Discard all and stop`. Suffix `(Recommended)` on the acceptable contestant with the fewest fixes,
breaking ties by the smallest total diff. If no contestant is acceptable, recommend none and say
so plainly.

If the user discards all, remove every selectable contestant worktree, leave every patch file in
place, print all patch paths, and report the cleanup results. Retain withdrawn contestants as
specified above. Otherwise save the selected contestant as the winner. After this selection
question is answered, remove every unchosen selectable worktree with:

```bash
git -C "<mainRoot>" worktree remove --force "<worktreePath>"
```

Print each losing patch path; patch files survive cleanup. If loser removal fails, report the exact
failure and path but continue the winner's hand-back without destructive recovery.

## Hand-back and cleanup

For the chosen winner only, recompute:

```bash
git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all
git -C "<mainRoot>" rev-parse HEAD
```

Report every overlap between patched paths and currently dirty main-tree paths, and report when
`HEAD` moved from `baselineCommit`. Show the winning patch stat and ask exactly once:

- `Apply the patch to the working tree (Recommended)`
- `Leave the patch and the worktree for me`
- `Discard the worktree without applying`

When `HEAD` moved, say inside that question that a 3-way merge may conflict. When a patched path
overlaps a currently dirty path, say inside the same question that apply is refused until that
overlap is cleaned; if the user nevertheless selects apply, do not run Git, retain the patch and
worktree, and report the refusal.

On an allowed apply, first run:

```bash
git -C "<mainRoot>" apply --3way --check "<patchFile>"
```

Only after that succeeds run:

```bash
git -C "<mainRoot>" apply --3way "<patchFile>"
```

The check validates pre-images and index compatibility, but with `--3way` it cannot detect every
merge conflict. Capture the pre-apply status. A real apply can exit nonzero, leave conflict markers,
and create unmerged index entries on paths that were clean before it. A successful apply stages the
delta because `--3way` implies `--index`; nothing is committed or pushed.

On failure at either step, report Git's exact stdout and stderr plus:

```bash
git -C "<mainRoot>" diff --name-only --diff-filter=U
```

For a real-apply failure, identify every conflict path that was clean before the apply. Keep the
patch and winner worktree and hand resolution to the user. Explain that the user can return those
paths to their pre-apply `HEAD` state with a user-chosen `git reset -- <paths>` followed by
`git checkout -- <paths>`; never run that recovery automatically.

Remove the winner's worktree automatically only after the user confirms a successful patch apply.
The explicit `Discard the worktree without applying` choice also authorizes its removal while the
patch file remains recoverable. For `Leave`, an overlap refusal, an apply failure, or any other
non-confirmed result, print `<worktreePath>`, `<patchFile>`, and this exact command, and say the
worktree was intentionally left in place:

```bash
git -C "<mainRoot>" worktree remove --force "<worktreePath>"
```

Always print retained withdrawn-contestant worktrees and their exact removal commands. A session
ending mid-tournament can strand worktrees but cannot strand tournament state because none is
written; recover with `git -C "<mainRoot>" worktree list --porcelain` and the removal command above.

## Post-hand-back verification and final report

After a confirmed successful apply, run the repository's identifiable host gates once in the main
tree. For this repository run and record every command's exact exit result:

```text
npm test
npm run typecheck
npm run lint
npm run format:check
npm run check-version
```

Elsewhere, use the documented equivalents. A gate failure is a reported hand-back result; never
hide it or claim the applied delta was verified.

The final report includes:

- the plan slot and every contestant's label, model, effort, job id, thread id, status, and review
  verdict
- the winner and the evidence behind the user's choice, including identical-delta notes and
  reported deviations
- the hand-back result, including `staged, not committed` on success and every conflicted path on
  failure
- every retained worktree, every patch path, every cleanup failure, and the exact recovery commands
- every main-tree gate command and exit result, or that gates did not run without a confirmed apply
- every implementer and reviewer invocation's usage and duration, using `usage unavailable` when
  omitted

State the cost plainly: the tournament launches 2–3 concurrent Codex write turns plus one review
per non-empty completed contestant, so rate limits and usage can be materially higher than
`/stereo:implement`. Repeat that the plan was not marked implemented, no implementation or
tournament record was written, and the tournament has no `--resume`. Point to
`/stereo:implement --review-only` for a fresh gate on the applied delta and to
`git -C "<mainRoot>" worktree list --porcelain` plus `git worktree remove --force` to find and
remove a worktree stranded by a crash. Never commit or push.
