---
description: Race Claude and Codex implementers on an approved plan; hand back the winning delta
argument-hint: '[--implementer <model>]... [--implementer-effort <none|minimal|low|medium|high|xhigh|max>]... [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--slot <name>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(npm:*), Bash(git:*), AskUserQuestion, Agent
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md` and apply its routing, foreground
agent, validation, quoting, and background-job rules. The rules below are step-specific.

Run one stored plan through independent Codex-routed or Claude-routed contestants in isolated
worktrees. Codex contestants run as concurrent detached jobs, while Claude contestants run one at a
time in the foreground. The main Claude session owns preflight, containment, evidence collection,
independent reviews, winner selection, hand-back, cleanup, and final verification.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments

After reading the routing skill, parse all arguments before loading state:

- `--implementer <model>` is repeatable and optional. Declaration order defines contestant labels
  `c1`, `c2`, and `c3`; duplicate models are legal and produce independent samples of the same
  model. Zero occurrences select the built-in default lineup below. With one, stop, explain that a
  single contestant is not a tournament, and name `/stereo:implement` as the single-implementer
  command. Two or three occurrences define the lineup explicitly. With four or more, stop and
  state that tournaments are capped at 3 contestants.
- Accept `claude:sonnet`, `claude:opus`, `claude:haiku`, `claude:fable`, and `claude:inherit` as
  Claude contestants. Accept a Codex selection with or without the `codex:` prefix. Reject
  `claude:session` because Claude writes must stay inside the contained `stereo:implementer` agent;
  reject unknown `claude:*` values and `codex:claude:*`. A Claude contestant runs as one foreground
  `stereo:implementer` invocation in its own worktree, so multiple Claude contestants run
  sequentially.
- `--implementer-effort <none|minimal|low|medium|high|xhigh|max>` is repeatable with positional
  pairing. It is legal only when `--implementer` is present, every contestant is Codex-routed, and
  its occurrence count equals the `--implementer` count exactly; the k-th effort pairs with the
  k-th contestant. Reject a partial list and name the exact implementer and effort counts seen.
  Reject the flag entirely when `--implementer` is absent, name the built-in default lineup, and
  point to `--effort`. When any contestant is Claude-routed, reject the flag, name every such label
  and selection, say that Claude has no effort dial, and point to `--effort` as the shared Codex
  effort.
- `--implementation-reviewer <model>` selects one shared implementation reviewer. Accept it once
  and resolve it as explicit flag > workspace `implementationReviewer` default > `claude:fable`.
  `claude:session` is legal for this role.
- `--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort
  for a Codex-routed reviewer and is illegal for a Claude-routed reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for Codex roles
  without a role effort flag.
  When no active role is Codex-routed, a command-wide `--effort` is inert: accept it, report it as
  inert, and never translate it into a Claude-side control.
- `--slot <name>` selects the stored plan slot and defaults to `default`. Define `<slotArg>` as
  `--slot <slot>` for a non-default slot and omit it entirely for `default`.

When `--implementer` is absent entirely, use the built-in default lineup: `c1` = `codex:sol`,
`c2` = `claude:opus`. It is hardcoded here; `/stereo:config` has no contestant role default.
Report the lineup as the default lineup before launch.

Only the models are hardcoded. The Codex effort ladder below gives `c1` its `max` model-pair
default unless `--effort` or the valid workspace implementer effort default overrides it.

Claude contestants have no effort dial: model selection is the per-invocation Claude strength
control, and Stereo's agent definitions omit `effort`, so a Claude contestant runs at the session's
configured effort. Report its effort as `not applicable` and never state that an effort was applied.
For `claude:inherit`, report the effective model returned by the Agent result, or `unavailable`.

Reject missing values, duplicate single-occurrence flags, invalid efforts, positionals, unknown
flags, unknown `claude:*` values, and `codex:claude:*` before repository work. For Codex contestants
only, resolve effective effort as paired `--implementer-effort`, then command-wide `--effort`, then
the valid workspace implementer effort, then the routing skill's model-pair default. A Claude
contestant takes no effort argument; any stored workspace implementer effort is inert for it.
Resolve a Codex reviewer's effort as `--implementation-reviewer-effort`, then command-wide
`--effort`, then the valid workspace implementation-reviewer effort, then the model-pair default.
Omit a null effort argument.

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

The workspace `implementer` model never supplies a contestant, in either the explicit or the
default lineup: contestant models come only from `--implementer` or the built-in default lineup.
Its valid effort still participates in the effort ladder for Codex contestants and is inert for
Claude contestants. The workspace `implementationReviewer` entry participates normally in
reviewer model and effort resolution.

Before launching anything, state whether the lineup is default or explicit and state each
contestant's label, route, selection, and effective effort (`not applicable` for Claude), plus the
reviewer's final effective model and effort. State that Claude contestants are file-edits-only with
no shell, name any obviously shell-requiring plan steps that will appear as deviations, and say that
multiple Claude contestants run sequentially.

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
`/stereo:status`, `/stereo:result`, and `/stereo:cancel` see every Codex contestant's implementation
job from the main repository and no worktree-keyed broker is started.

`<isolationArgs>` applies to the implementation launch only for Codex contestants. A Claude
contestant has no companion implementation invocation: pass its `<worktreePath>` as absolute paths
inside the Agent prompt. It therefore has no implementation job id, no log, and no visibility in
`/stereo:status`, `/stereo:result`, or `/stereo:cancel`.

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

Include the latest-findings block only when `storedPlanFindings` is non-empty. This task text is
shared by both routes so the comparison measures the model, not the prompt.

### Launch order

Launch every Codex contestant first in label order, then run every Claude contestant in label
order, then poll the Codex jobs to terminal. Never interleave the passes: a foreground Agent
invocation blocks the orchestrator for that contestant's whole run, so launching a Codex contestant
afterwards would idle it for that entire time and break the busy-fallback stagger. With no Codex
contestant, go straight to the sequential Claude runs. With no Claude contestant, the flow is
exactly the Codex-only flow below.

### Codex contestants

Launch each Codex contestant with this canonical line, parsing and saving its `jobId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <contestantModel> <contestantEffortArg> <isolationArgs> --prompt-file "<payloadFile>"
```

Launch Codex contestants strictly in label order. Immediately after each launch, run exactly one
flagless instant status call, never `--wait` and never a loop, report its phase, and only then
launch the next Codex contestant:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId>
```

The shared workspace broker serializes turns, so the first Codex contestant holds its turn slot and
later Codex contestants deterministically fall back to a private Codex runtime, while interleaved
setup requests can still produce a transient busy rejection.

If a Codex contestant reaches `failed` with an error saying the shared Codex broker is busy,
relaunch it exactly once with the identical payload file, worktree, model, and effort flags; run the
same one instant status call, and replace its old job id with the new one. Never retry that
condition again. Any other failed job, a second busy failure, or a cancelled job withdraws the
contestant with its exact status and error.

### Claude contestants

For each Claude contestant, in label order:

1. Invoke the routing skill's foreground template:

   ```text
   subagent_type: "stereo:implementer"
   model: "<sonnet|opus|haiku|fable>"
   run_in_background: false
   prompt: |
     [complete contestant prompt]
   ```

   For `claude:inherit`, omit the `model` parameter entirely.

2. Compose the complete contestant prompt in this order:

   - Begin with the routing skill's fixed lead line:

     ```text
     Apply only the requested file edits. Never request command execution.
     ```

   - Include the same `<task>` block written for the Codex contestants above, verbatim: use the
     approved or unapproved variant, the same advisory or latest-findings inclusion rule, and the
     same `The working root for this task is <worktreePath>...` sentence.
   - Include `<action_safety>` and `<completeness_contract>` verbatim from the shared payload.
   - In place of `<verification_loop>`, include:

     ```text
     <verification_loop>
     You have no shell and cannot run tests, builds, or any other gate. Never claim verification.
     List every shell-requiring plan step under `Deviations`.
     </verification_loop>
     ```

   - Include this worktree-paths block, reusing `/stereo:implement`'s isolated-mode containment:

     ```text
     <worktree_paths>
     Use absolute paths under <worktreePath> for every Read, Glob, Grep, Edit, and Write operation.
     Never read or write anything under <mainRoot>. The worktree is a clean checkout at
     <baselineCommit>, so every change in it is this contestant's delta.
     </worktree_paths>
     ```

   - In place of `<compact_output_contract>`, require a compact plain-text agent report with the
     exact labels `Files touched`, `Plan steps completed`, and `Deviations`.

3. Validate those three labels through the routing skill. Record the Agent result's per-invocation
   usage and duration, or `usage unavailable`. For `claude:inherit`, record the effective model
   reported by the Agent result, or `unavailable`. Never continue one implementer agent across
   contestants: every contestant is a fresh invocation.

4. If the report is malformed or missing, do not retry the agent. Re-invoking a write agent against
   a worktree that already holds partial edits is a fix round, not a fresh sample. Record
   `report unavailable or malformed`, keep the contestant reviewable, and let its worktree diff and
   review speak; an empty delta then follows the existing empty-patch rule. This deliberately
   overrides the routing skill's generic retry-then-inline rule. There is no inline fallback because
   Claude writes must stay in the contained agent.

5. A harness denial of reads or writes under `<worktreePath>`, or any other agent-run failure,
   withdraws that contestant with the exact denial or error text. Never fall back to the main tree
   and never retry there. In `/stereo:implement`, such a denial ends the only implementation path,
   so stopping is that command's result; here it ends one contestant, and `withdrawn` already
   expresses that outcome. An Agent-tool or selected-model availability error instead follows the
   routing skill's immediate-stop rule: report it verbatim, never substitute a model, stop the
   tournament, and keep every worktree and patch. Apply the mid-flight stop reporting rule below.

6. When the tournament stops while Codex contestants are still running, list their job ids and say
   they keep running until they finish or are cancelled with `/stereo:cancel`. State that their
   results remain readable with `/stereo:status` and `/stereo:result`.

### Withdrawal and completion

A contestant is completed when its Codex job reaches `completed` or its Claude agent invocation
returns, including the recorded `report unavailable or malformed` case under the no-retry rule. It
is withdrawn in every other terminal case: a terminal non-completed Codex job after the
relaunch-once rule, or a denied, errored, or otherwise failed Claude agent run. It is excluded from
evidence review and selection, but its worktree is retained and reported with the exact removal
command so partial work is never destroyed. Continue with the remaining contestants and stop after
containment only if no contestant completes successfully.

## Waiting and containment

Rotate through all non-terminal Codex contestants and poll each through the routing skill's bounded
window command until every Codex job is terminal. Claude contestants are already terminal before
polling starts; when there is no Codex contestant, skip directly to the containment guard:

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

Run the containment guard immediately after each Claude contestant invocation returns, before
starting another Claude contestant, and once more after every contestant is terminal:

```bash
git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all
```

Compare its exact path set with `baselineDirty`. Any new main-tree path means an implementer wrote
outside its worktree. Concurrent execution makes attribution impossible: stop the whole tournament,
report the paths verbatim, hand back nothing, remove no worktree, and list every worktree path plus
its exact removal command. Codex-reported `touchedFiles` are absolute to a worktree and are not
main-tree writes. Report each Claude contestant's reported `Files touched` alongside the offending
paths as evidence, but state that this is not attribution. While Codex contestants run concurrently,
the guard cannot attribute the paths; when none are running, it still does not accept a
self-reported file list as attribution. The stop remains unconditional. If the guard fires while
Codex contestants are still running, apply the mid-flight stop reporting rule above.

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
treat the delta as verified. Run the complete gate set once in the main tree only after a successful
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

The review path is identical for both contestant routes because the delta is always the worktree
diff computed above, so all four placeholder fills remain unchanged. The verbatim implementer
report in `{{REVIEW_CONTEXT}}` is the Codex job report, the Claude agent report, or the recorded
`report unavailable or malformed` note.

The filled result is that contestant's `implementationReviewBrief`. Route it through the one
selected reviewer. It may share a route or even a model with a contestant; that is legal because
every review is a fresh independent invocation:

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

- label and route; `codex:`- or `claude:`-prefixed selection and effective effort, using
  `not applicable` for a Claude contestant; implementation job id and thread id, also using
  `not applicable` for a Claude contestant; for `claude:inherit`, the Agent-reported effective
  model or `unavailable`
- files changed and total insertions/deletions
- review `acceptable`, fix count, and summary
- reported deviations
- per-invocation usage and duration for both implementer and reviewer turns

For Codex use `storedJob.tokenUsage.job`; for named Claude use the Agent result. This applies to
both contestants and reviewers. Print `usage unavailable` rather than omitting an unavailable
metric. State beside the table that no candidate has passed host gates. A Claude contestant could
not run any command at all, so its shell-requiring plan steps appear as deviations. Also flag
byte-identical deltas.

Print the comparison table before making or asking for any decision. Define the selectable
contestants as the non-empty, completed contestants with validated review verdicts; an unvalidated
review already stopped the run under the rules above. Evaluate this ordered decisiveness rule over
that set:

1. `single-acceptable` — exactly one contestant is `acceptable`. Select it as the winner without
   asking.
2. `identical-acceptable` — two or more contestants are acceptable and every acceptable
   contestant's patch file is byte-identical. Select the lowest-labeled acceptable contestant
   without asking, and state that the choice is immaterial because those deltas are identical.
3. `tie-ask` — two or more contestants are acceptable and their deltas differ. The evidence is
   ambiguous, so ask.
4. `none-acceptable-ask` — zero contestants are acceptable. The evidence is ambiguous, so ask.

The implementation-review contract makes these branches exhaustive: `acceptable: true` is valid
only with an empty `fixes` array, so every acceptable contestant has zero fixes and fix count cannot
separate two acceptable contestants. Total diff size is not decisive evidence and must never
auto-select a winner.

For either decisive branch, announce the auto-selection before proceeding. Name the rule id and
the winner's label, route, selection, verdict, and review summary. Name every rejected alternative
with its verdict and fix count, and include every withdrawn or empty contestant. When the winner is
the only selectable contestant, say so explicitly rather than overstating the comparison.

For either ask branch, use `AskUserQuestion` exactly once with one option per selectable contestant
plus `Discard all and stop`. For `tie-ask`, suffix `(Recommended)` on the acceptable contestant with
the smallest total diff; this is a recommendation tie-break only. For `none-acceptable-ask`,
recommend none and say so plainly.

If the user discards all, remove every selectable contestant worktree, leave every patch file in
place, print all patch paths, and report the cleanup results. Retain withdrawn contestants as
specified above. Otherwise save the selected contestant as the winner. After this selection
question is answered or after an auto-selection announcement, remove every unchosen selectable
worktree the same way with:

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
`HEAD` moved from `baselineCommit` as the first hand-back step on both selection paths.

An auto-selected winner is eligible for automatic apply only when all four preconditions are
provably true:

1. The winner was auto-selected, so it is `acceptable` with zero fixes.
2. No patched path overlaps the recomputed main-tree dirty path set.
3. The recomputed `HEAD` still equals `baselineCommit`.
4. `git -C "<mainRoot>" apply --3way --check "<patchFile>"` exits zero.

If precondition 2 or 3 fails, fall back to the same three-option hand-back question used for a
user-selected winner. Include the existing overlap-refusal or moved-`HEAD` warning described below.
If both hold, capture the pre-apply status and evaluate precondition 4. When the check succeeds,
apply without asking and report that the apply was automatic under the named decisiveness rule.
When the check fails, do not apply; use the failure reporting below and retain the patch and
worktree.

For a user-selected winner, or for an auto-selected winner falling back because precondition 2 or
3 failed, show the winning patch stat and ask exactly once:

- `Apply the patch to the working tree (Recommended)`
- `Leave the patch and the worktree for me`
- `Discard the worktree without applying`

When `HEAD` moved, say inside that question that a 3-way merge may conflict. When a patched path
overlaps a currently dirty path, say inside the same question that apply is refused until that
overlap is cleaned; if the user nevertheless selects apply, do not run Git, retain the patch and
worktree, and report the refusal.

On an allowed apply from the question, capture the pre-apply status and first run the same check
used for automatic apply:

```bash
git -C "<mainRoot>" apply --3way --check "<patchFile>"
```

Only after that succeeds run the following command. On the automatic path, run it immediately
after the successful precondition-4 check without asking:

```bash
git -C "<mainRoot>" apply --3way "<patchFile>"
```

The check validates pre-images and index compatibility, but with `--3way` it cannot detect every
merge conflict. A real apply can exit nonzero, leave conflict markers, and create unmerged index
entries on paths that were clean before it. A successful apply stages the delta because `--3way`
implies `--index`; nothing is committed or pushed. If the pre-apply status contained unrelated
staged work on non-overlapping paths, report plainly that it remains staged in the same index as the
applied delta.

The following failure block applies to both automatic and user-confirmed applies. On failure at
either step, report Git's exact stdout and stderr plus:

```bash
git -C "<mainRoot>" diff --name-only --diff-filter=U
```

For a real-apply failure, identify every conflict path that was clean before the apply. Keep the
patch and winner worktree and hand resolution to the user. Explain that the user can return those
paths to their pre-apply `HEAD` state with a user-chosen `git reset -- <paths>` followed by
`git checkout -- <paths>`; never run that recovery automatically.

After a successful automatic apply, report every applied path. State explicitly that a user-chosen
`git reset -- <paths>` followed by `git checkout -- <paths>` returns tracked paths to `HEAD`, while
files newly added by the patch must be removed by hand.

Remove the winner's worktree automatically after a successful patch apply on either path, whether
user-confirmed or decisive and automatic. The explicit `Discard the worktree without applying`
choice also authorizes its removal while the patch file remains recoverable. For `Leave`, an overlap
refusal, an apply failure, or any other non-success result, print `<worktreePath>`, `<patchFile>`, and
this exact command, and say the worktree was intentionally left in place:

```bash
git -C "<mainRoot>" worktree remove --force "<worktreePath>"
```

Always print retained withdrawn-contestant worktrees and their exact removal commands. A session
ending mid-tournament can strand worktrees but cannot strand tournament state because none is
written; recover with `git -C "<mainRoot>" worktree list --porcelain` and the removal command above.

## Post-hand-back verification and final report

After any successful apply, whether user-confirmed or decisive and automatic, run the repository's
identifiable host gates once in the main tree. For this repository run and record every command's
exact exit result:

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

- whether the lineup was default or explicit, the plan slot, and every contestant's label, route,
  model, effort, job id, thread id, status, and review verdict; use `not applicable` for a Claude
  contestant's effort, job id, and thread id
- which of `single-acceptable`, `identical-acceptable`, `tie-ask`, or `none-acceptable-ask` fired;
  whether that rule selected the winner automatically or caused the user to be asked and why the
  evidence was ambiguous; the winner and its evidence; and every alternative with its verdict,
  including identical-delta notes and reported deviations
- the hand-back result, including whether apply was automatic or user-confirmed,
  `staged, not committed` on success, every conflicted path on failure, and, for an automatic
  success, the applied path list plus the tracked-path and newly-added-file revert instructions
  above
- every retained worktree, every patch path, every cleanup failure, and the exact recovery commands
- every main-tree gate command and exit result, or that gates did not run without a successful apply
- every implementer and reviewer invocation's usage and duration, using `usage unavailable` when
  omitted

State the cost plainly: the tournament launches one concurrent Codex write turn per Codex
contestant plus one sequential foreground Claude implementer run per Claude contestant, then one
review per non-empty completed contestant, so both providers' usage can be materially higher than
`/stereo:implement`. Repeat that the plan was not marked implemented, no implementation or
tournament record was written, and the tournament has no `--resume`. Point to
`/stereo:implement --review-only` for a fresh gate on the applied delta and to
`git -C "<mainRoot>" worktree list --porcelain` plus `git worktree remove --force` to find and
remove a worktree stranded by a crash. A Claude contestant has no job and cannot be cancelled with
`/stereo:cancel`; interrupting the session ends it and leaves its worktree discoverable with
`git -C "<mainRoot>" worktree list --porcelain`. Never commit or push.
