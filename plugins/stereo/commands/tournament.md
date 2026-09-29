---
description: Race Claude and Codex implementers on an approved plan; hand back the winning delta
argument-hint: '[--implementer <model>]... [--implementer-effort <effort>]... [--implementation-reviewer <model>] [--implementation-reviewer-effort <effort>] [--resume] [--slot <name>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(npm:*), Bash(git:*), Bash(npx:*), Bash(pnpm:*), Bash(yarn:*), Bash(dotnet:*), Bash(cargo:*), Bash(go:*), Bash(make:*), Bash(python3:*), Bash(pytest:*), Bash(mvn:*), Bash(gradle:*), AskUserQuestion
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md`, then
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/pair-procedures.md`,
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/implement-procedures.md`, and
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/worktree-procedure.md`, and apply their rules. The
rules below are step-specific; a quoted heading names the section of a routing file that defines
the step.

Run one stored plan through independent Claude and Codex contestants in isolated worktrees. Every
contestant, whichever runtime it selects, runs as a concurrent detached companion job. The main
Claude session owns preflight, containment, evidence collection, independent reviews, winner
selection, hand-back, cleanup, and final verification.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments

Parse all arguments per "Selection and effort parsing" before loading state, then read the
"Workspace role defaults":

- `--implementer <model>` is repeatable and optional. Declaration order defines contestant labels
  `c1`, `c2`, and `c3`; duplicate models are legal and produce independent samples of the same
  model. Zero occurrences select the default lineup below. With one, stop, explain that a single
  contestant is not a tournament, and name `/stereo:implement`. With four or more, stop and state
  that tournaments are capped at 3 contestants. `claude:session` is rejected as a contestant:
  Claude writes stay inside the contained implementer role.
- `--implementer-effort <effort>` is repeatable with positional pairing: legal only when its
  occurrence count equals the `--implementer` count exactly, the k-th effort pairing with the k-th
  contestant on that contestant's ladder. Reject a partial list naming both counts seen. Without
  `--implementer`, reject it, name the default lineup, and point to an explicit lineup with paired
  efforts or to `/stereo:config --implementer-effort`.
- `--implementation-reviewer <model>` selects the one shared implementation reviewer, resolved as
  the flag, else the workspace `implementationReviewer` default, else `claude:fable-5.1` (this
  command's own built-in). `--implementation-reviewer-effort <effort>` sets its effort.
- `--slot <name>` selects the stored plan slot and defaults to `default`.
- `--resume` re-enters the recorded incomplete tournament; the record owns the lineup, reviewer,
  every effort, and the plan slot. Reject `--implementer`, `--implementer-effort`,
  `--implementation-reviewer`, `--implementation-reviewer-effort`, and `--slot` with it, naming the
  recorded values: every contestant must face the same recorded reviewer, or the comparison is
  meaningless.

Reject duplicate single-occurrence flags and positionals. Reject `--isolated` (tournament
isolation is unconditional); `--implement-only`, `--review-only`, `--base`, and `--max-fix-rounds`,
naming `/stereo:implement` as their home; and `--fresh`, which is unnecessary because every
contestant starts fresh.

**Default lineup.** With no `--implementer`, `c1` is the workspace `implementer` model when its
entry has a null `invalidReason` and a `codex` route, else `codex:astra-6`; `c2` is
`claude:opus-5.5`, so the default lineup races one Codex contestant against one Claude contestant.
A valid Claude workspace implementer is inert here (the lineup already fields `claude:opus-5.5`):
report it by name and never launch it. Explicit `--implementer` flags always win, and no workspace
default is injected into an explicit lineup.

Before launching anything, announce the lineup source as `explicit`,
`default (workspace implementer default)`, or `default (built-in)`, naming the workspace selection
when it supplied `c1` or was inert. State each contestant's label, route, pinned selection
(**Preflight**), and effective effort, plus the reviewer's pinned selection and effort; list the
`--allow` rules for the Claude contestants and a Claude reviewer (or say none were needed) and the
user-owned steps the implementer scan recorded, which will appear as deviations.

## Preflight

For `--resume`, use **Resuming an interrupted tournament** instead.

1. Load the selected stored plan:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
   ```

   If `available` is false, run `plan-state --list --json`; name every populated slot, or else stop
   and direct the user to `/stereo:plan`. Retain the complete plan and the `findings` array as
   `storedPlanFindings` (empty when missing or not an array). Every contestant starts in a fresh
   thread or session of its own.

2. If the stored verdict is not `approve`, show its verdict, round, `updatedAt`, reviewer label,
   residual-risk status, finding count, and `implementedAt` when present, then ask exactly once:
   - `Run /stereo:plan first (Recommended)`
   - `Run the tournament on the unapproved plan anyway`
   - `Stop here`

   An approved plan's `implementedAt` is reported, never treated as permission to skip a step.

3. Inspect the workspace implementation record without changing it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --json
   ```

   If a record exists with `status: in-progress`, report its baseline, round, and worktree, and ask
   exactly once whether to continue anyway or stop: a hand-back into a tree with a live
   implementation phase makes attribution ambiguous. The tournament never writes this record.

4. Set `baselineCommit` from `git rev-parse HEAD` and `baselineDirty` from the exact path set of
   `git status --porcelain=v1 --untracked-files=all`, then run the extra preflight of "Isolated
   worktrees" once for the whole field. Store that set in the record as `baselineDirtyPaths`.
5. **Implementer scan.** When the lineup fields a Claude contestant, scan the stored plan once as
   step 2 of "Implementation preflight" does, collecting `implementerAllowRules`, with no switch
   question, since the lineup is fixed. If out-of-scope steps exist, ask exactly once whether to
   continue with those steps user-owned for every Claude contestant (recommended; a Codex
   contestant may still run them in its sandbox) or stop. Record them as `userOwnedSteps` (`[]`
   without a Claude contestant) and repeat them in the comparison table and the final report.
6. **Pins and grants.** Before any worktree exists, derive the reviewer's commands per
   "Verification grants" from the plan's `## Testing and verification` section and run the pin dry
   runs of "Implementation preflight" once per contestant (its selection, paired effort, and
   `<implementerRoleArgs>`) and once for a companion reviewer. Any refusal is a launch error: stop.
   Each payload pins that role and supplies its `launchArgs`.
7. State before launch that the tournament writes a durable tournament record and, after a fully
   successful hand-back, marks the plan implemented; it never writes `implement-state`, commits, or
   pushes.

## Tournament state record

Write `<statePayloadFile>` under "Quoting" and use these actions; `<slotArg>` appears only on the
fresh record action:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --record --state-file '<statePayloadFile>' --json <slotArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --update --state-file '<statePayloadFile>' --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --complete --state-file '<statePayloadFile>' --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --clear --json
```

Read the record with flagless `tournament-state --json`. It contains `version`, `status`,
`baselineCommit`, `baselineDirtyPaths`, `mainRoot`, `lineupSource` (`default` or `explicit`),
`userOwnedSteps`, and `reviewer` with `selection`, `route`, `model`, `effort`, and `launchArgs`
(its pinning dry run's). Its `contestants[]` entries contain `label`, `route`, `selection`,
`model`, `effort`, `launchArgs`, `source` (`flag`, `workspace-default`, or `built-in`),
`worktreePath`, `removeCommand`, `provisioning`, `jobId`, `threadId`, `status` (`pending`,
`running`, `completed`, `withdrawn`, or `empty`), `patchFile`, a `review` with `acceptable`,
`fixCount`, and a bounded `summary`, and a bounded `note`. It may also contain `winner` with
`label` and `rule`, and `handBack` with `decision`, `applied`, `conflictPaths`, `gates[]`, and
`markedImplemented`. The companion adds the `plan` snapshot and timestamps. Every `effort` is the
effort its pinning dry run printed, and every launch replays its recorded `launchArgs`, which pin
it as "Implementer launches and payloads" states.

Store bounded summaries, never verbatim reports; the companion rejects a `--state-file` over 512
KiB. An update merges `contestants[]` by `label` and replaces the recorded entry, so always send the
complete entry. A fresh record replaces any older one; there is one per workspace, so concurrent
tournaments are last-write-wins. Clearing a stored plan does not clear this record; its clear
action is the explicit reset and reports retained worktree paths with their removal commands. Every
state-write failure is reported but never fails the tournament.

## Worktrees

For each contestant in order, create and provision a worktree with the creation and provisioning
steps of "Isolated worktrees", saving its `<worktreePath>` and `<removeCommand>`. If any creation
fails, remove every worktree already created with the cleanup step's `worktree remove` call, report
the exact failure, and stop without launching a contestant. A documented install is a
per-contestant cost: run one only when the plan builds or tests artifacts and a needed dependency
was neither linked nor present. The tournament takes no baseline gate snapshot.

Each contestant's `<isolationArgs>` comes from its own `<worktreePath>` and goes on its launch and
on each review launch for it. Once every worktree exists, and before the first launch, write the
record action with every contestant at `status: pending`.

## Launching contestants

Create one distinct `<payloadFile>` and `<launchArgsFile>` per contestant. Every payload is the
shared payload of "Implementer launches and payloads" in its isolated form — the approved opening
normally, the unapproved one when the user passed the preflight gate — with the full stored plan
verbatim, the advisory or latest-findings block when `storedPlanFindings` is non-empty, the
working-root sentence, the contestant's provisioning status, and, for a Claude contestant only, the
recorded `userOwnedSteps`. A Claude contestant keeps the shared isolated `<verification_loop>`; a
Codex contestant receives this one in its place:

```text
<verification_loop>
Run the repository's relevant tests or build and fix regressions when their dependencies are
present in this worktree. This worktree is a fresh checkout, so gitignored dependencies and
generated artifacts may be absent; if a gate cannot run, say so explicitly and never report
unverified work as verified.
</verification_loop>
```

The task text is otherwise shared by both routes so the comparison measures the model, not the
prompt. Only the payload and the launch line come from that section: polling, validation, and
withdrawal follow this command's rules, and no contestant is ever relaunched — on a resume
failure, a malformed report, or any other failure.

### Launch order

Launch every contestant strictly in label order with the fresh line of "Implementer launches and
payloads", its `<launchArgsFile>` holding the `launchArgs` recorded with its `pending` entry.
Immediately after each launch, save its `jobId` and `status: running` with the update action, then
launch the next contestant; no launch waits for another contestant's run. A resumed tournament
launches a pending contestant the same way.

### Withdrawal and completion

A contestant is completed when its job reaches `completed`, including a Claude contestant whose
report is malformed or missing: never relaunch it — relaunching a write job against a worktree that
already holds partial edits is a fix round, not a fresh sample. Record
`report unavailable or malformed` and let its worktree diff and review speak; an empty delta
follows the empty-patch rule.

It is withdrawn in every other terminal case — failed, cancelled, write-denied, or a model the CLI
rejected after the job record existed — with its `storedJob.errorMessage`. Withdrawal is this
command's outcome under "Failed and cancelled jobs": report the job id, error, and resume hint,
record the withdrawal, and ask no relaunch question. A withdrawn contestant is excluded from
evidence review and selection, but its worktree is retained and reported with its
`<removeCommand>`. Continue with the remaining contestants; stop after containment only if no
contestant completes, leaving the record in progress (`/stereo:tournament --resume` re-enters it,
`tournament-state --clear` discards it).

A launch error follows "Launch errors": stop the tournament and keep every worktree and patch.
When the tournament stops while contestants are still running, list their job ids and say they
keep running until they finish or are cancelled with `/stereo:cancel`, with their results readable
through `/stereo:status` and `/stereo:result`.

## Waiting and containment

Rotate through all non-terminal contestants, polling each through "Companion background jobs" and
reporting its phase and elapsed time between polls, until every job is terminal. Fetch each
terminal contestant's result and save its report, `threadId`, applied `effort`, `touchedFiles`,
usage (`tokenUsage.job`, or `usage unavailable`), any `droppedNotifications`, and, for a Claude
contestant, the Claude invocation note; validate a Claude contestant's four labels through
"Validating companion role results". Then save the complete contestant entry with its status
(`completed` or `withdrawn`), `threadId`, and a bounded usage note.

Once every contestant is terminal, run the containment guard of "Isolated worktrees" against
`baselineDirty`. Any new main-tree path means an implementer wrote outside its worktree, and
concurrent execution makes attribution impossible: stop the whole tournament, report the paths
verbatim, hand back nothing, remove no worktree, and list every worktree path with its
`<removeCommand>`. The record stays in progress; name `tournament-state --clear` as the reset, since
a resume would re-run this guard and stop again. Report each contestant's self-reported files
(`touchedFiles`, a Claude contestant's `Files touched`) beside the offending paths as evidence, but
state that this is not attribution: the stop is unconditional.

## Evidence

For each completed contestant, create its recovery patch and comparison evidence with the four
patch commands of the delta hand-back step of "Isolated worktrees", in its worktree. The patch
preserves every completed contestant's full delta after a losing worktree is removed. Report a
contestant with an empty patch as producing no delta and exclude it from review and selection. If
every completed contestant is empty, report that, remove all completed contestants' worktrees,
print every patch path, retain and report any withdrawn contestant worktrees, and stop; the record
stays in progress, so name `tournament-state --clear` as the reset. Save every completed
contestant's `patchFile` (and `status: empty` where the delta is empty) in one update. Detect
byte-identical patch files and say so in the comparison.

Do not run host gates per contestant: the orchestrator's full battery for every candidate would
multiply its cost by the field size to verify deltas that will mostly be discarded, and the one
delta that survives gets the authoritative main-tree run after hand-back. For every contestant
`{{HOST_RESULTS}}` states that the orchestrator ran no gates in this worktree and that the delta is
not host-verified, plus the contestant's own reported checks labeled `contestant-reported checks`
with its route stated beside the label.

## Per-contestant implementation review

Review every non-empty completed contestant exactly once, through one round of "Implementation
review rounds" with the reviewer's recorded `launchArgs` in `<reviewLaunchArgsFile>` and the
contestant's `<isolationArgs>` — the same reviewer, grants, and effort for every contestant. A
companion reviewer launches every contestant's review in label order, each with its own payload file
and a fresh thread, then rotate-polls them to terminal; a `claude:session` reviewer reviews strictly
sequentially in contestant order, targeting each worktree as "Isolated worktrees" (review and
verification target) states. The brief fills:

- `{{PLAN_INPUT}}` = the full stored plan.
- `{{BASELINE_CONTEXT}}` = that the delta lives in the isolated worktree at `<worktreePath>` at
  `<baselineCommit>`; the diffstat, changed-file list, and complete diff; that fix `file` values
  remain repository-relative and identical in both trees; and that the main tree is not the review
  target.
- `{{REVIEW_CONTEXT}}` = that this is a single-round tournament review of one contestant's delta,
  that there are no earlier implementation-review rounds, and that no fixes will be applied; the
  contestant's report verbatim (or the recorded `report unavailable or malformed` note); and
  `storedPlanFindings` verbatim when non-empty, labeled advisory when the stored verdict is
  `approve` and as known unapproved findings otherwise.
- `{{HOST_RESULTS}}` = the per-contestant statement of **Evidence**.
- `{{GRANTED_COMMANDS}}` = the reviewer's derived commands from the plan's
  `## Testing and verification` section, one per line (worktree-targeted for `claude:session`), or
  `none`.

The briefs never mention another contestant, so concurrent execution changes nothing about their
independence. Every contestant gets exactly one review round: no gate-fix pre-loop precedes it, and
a `fixes` verdict feeds selection only — no fix turn is ever dispatched. The reviewer may share a
model with a contestant: that is the "Same-model rule" tournament exception. Validation and the one
malformed-output retry follow that section; after an exhausted retry, ask whether to perform only
that contestant's review inline or stop, never inferring a verdict. A review job that fails or is
cancelled follows "Failed and cancelled jobs", recorded in that contestant's entry, with the
question limited to relaunching that review fresh or stopping. A launch error keeps all remaining
worktrees and patches. Never mention one contestant's delta or verdict to another's reviewer. Save
each validated `review` in the contestant's entry.

## Selection

Present one comparison-table row per non-empty completed contestant: label and route; prefixed
selection and effective effort; implementation job id and thread id, with the Claude invocation
note for a Claude contestant; files changed and total insertions/deletions; review `acceptable`,
fix count, and summary; `self-review` when the reviewer's resolved id equals the contestant's;
reported deviations; and per-invocation usage and effort for both implementer and reviewer turns
(an inline review has no usage line). State beside the table that no candidate has passed the
orchestrator's main-tree gates — contestant self-reports are `contestant-reported checks` only —
and that the recorded `userOwnedSteps` appear as a Claude contestant's deviations. Flag
byte-identical deltas.

Print the table before making or asking for any decision. The selectable contestants are the
non-empty completed contestants with validated review verdicts. Evaluate this ordered rule:

1. `single-acceptable` — exactly one contestant is `acceptable`. Select it without asking.
2. `identical-acceptable` — two or more are acceptable and every acceptable contestant's patch
   file is byte-identical. Select the lowest-labeled one without asking, stating that the choice is
   immaterial.
3. `tie-ask` — two or more are acceptable and their deltas differ. Ask.
4. `none-acceptable-ask` — none is acceptable. Ask.

`acceptable: true` is valid only with an empty `fixes` array, so fix count cannot separate two
acceptable contestants, and total diff size never auto-selects a winner. For a decisive branch,
announce the rule id and the winner's label, route, selection, verdict, and review summary; name
every rejected alternative with its verdict and fix count, every withdrawn or empty contestant, and,
when the winner is the only selectable contestant, say so. For an ask branch, use `AskUserQuestion`
exactly once with one option per selectable contestant plus `Discard all and stop`; for `tie-ask`,
suffix `(Recommended)` on the acceptable contestant with the smallest total diff (a recommendation
tie-break only), and for `none-acceptable-ask` recommend none and say so.

Save the winner's label and rule id, or the discard-all outcome, with the update action. Then
remove every unchosen selectable worktree with the cleanup step's `worktree remove` call (on
discard-all, every selectable one), printing each patch path — patch files survive cleanup. A
failed removal is reported with its path and `<removeCommand>` without stopping the winner's
hand-back.

## Hand-back and cleanup

Hand the winner's delta back with the delta hand-back and cleanup steps of "Isolated worktrees",
with these differences:

- An auto-selected winner is applied without asking when all four preconditions hold: it was
  auto-selected (so `acceptable` with zero fixes), no patched path overlaps the recomputed dirty
  set, the recomputed `HEAD` still equals `baselineCommit`, and the `apply --3way --check` exits
  zero. Report that the apply was automatic under the named rule, every applied path, and that a
  user-chosen `git reset -- <paths>` followed by `git checkout -- <paths>` returns tracked paths to
  `HEAD` while newly added files are removed by hand. A failed check applies nothing: report it and
  retain the patch and worktree.
- A user-selected winner, or an auto-selected one whose overlap or `HEAD` precondition failed, gets
  the three-option question. When a patched path overlaps a currently dirty path, say in that
  question that apply is refused until the overlap is cleaned; if the user still selects apply, run
  no Git and retain the patch and worktree.

Save the `handBack` decision and result, including apply status and conflict paths. Always print
retained withdrawn-contestant worktrees with their `<removeCommand>`. A session ending
mid-tournament leaves a resumable record: recover with `/stereo:tournament --resume`.

## Resuming an interrupted tournament

1. Run flagless `tournament-state --json`. When `unreadable` is true, report `path` and
   `parseError`, then stop. If `available` is false, stop and direct the user to a fresh
   `/stereo:tournament` run. If `status: complete`, report the winner, hand-back result, and
   `completedAt`, then ask exactly once whether to start a fresh tournament, clear the record and
   stop, or stop without changing it.
2. Announce the recorded lineup, reviewer, every recorded effort and `launchArgs`, slot, baseline,
   and `userOwnedSteps`; they are authoritative, and every launch replays its recorded `launchArgs`.
   A record whose contestants or companion reviewer lack `launchArgs` was written by an earlier
   release and cannot be resumed: say so, list every recorded worktree path (the clear action and
   `/stereo:doctor` print their removal commands), and ask exactly once whether to clear it and
   start a fresh tournament or stop without changing it.
3. Take the slot from `plan.slot`, define `<slotArg>`, and run `plan-state --json <slotArg>`. If the
   plan is gone, report it, offer `tournament-state --clear`, and stop. When `planMatches` is false,
   show both fingerprints and timestamps, warn that `{{PLAN_INPUT}}` would use the current stored
   plan, and ask exactly once whether to continue or stop.
4. Verify that each recorded `worktreePath` is still a directory and appears exactly as a
   `worktree` line of `git -C '<mainRoot>' worktree list --porcelain`. A missing worktree withdraws
   that contestant; report its recorded patch path when one exists.
5. Verify the recorded baseline with `git cat-file -e '<baselineCommit>^{commit}'` and re-run the
   containment guard against the recorded `baselineDirtyPaths`; its unconditional stop applies.
6. Re-enter by recorded contestant status through the sections above. Before starting any
   `pending` contestant, run `git -C '<worktreePath>' add -N .` and check
   `git -C '<worktreePath>' diff --quiet '<baselineCommit>'`: state writes are best-effort, so a
   non-empty delta proves that something ran. Also list every session's jobs with
   `status --json --all`. A write job that no contestant entry records as its `jobId` (a crash
   inside the dispatch window) is reported by id and never attributed to a contestant; while such a
   job is queued or running, ask once whether to wait for it to settle (then re-run these checks) or
   stop, and launch nothing beside it. A `pending` or `running` contestant whose worktree holds a
   delta but no recorded `jobId` is judged from its delta without relaunching, recording
   `report unavailable or malformed`. Only an empty-delta `pending` contestant is launched, from its
   recorded `launchArgs` and `worktreePath`, once no unrecorded write job is live. Poll a `running`
   contestant with a recorded `jobId` through **Waiting and containment**. Send `completed` without
   `patchFile` to **Evidence**, patched without a recorded `review` to **Per-contestant
   implementation review**, all reviewed without a `winner` to **Selection**, a `winner` without
   `handBack` to **Hand-back and cleanup**, and an applied hand-back without recorded gates to
   **Post-hand-back verification and final report**.
7. Recorded gate results and reports are historical summaries, never current evidence; usage that
   was neither recorded nor re-fetchable is `usage unavailable`. Never re-review a contestant that
   already has a recorded validated verdict.

## Post-hand-back verification and final report

After any successful apply, run the repository's identifiable host gates once in the main tree —
the `authoritative host gates` for the applied delta, whatever any contestant reported: the fast
stage of "Staged verification" and, when every fast-stage gate is green, the documented heavy
stage (a no-op where the repository declares none). A gate failure is a reported hand-back result,
never fixed here; never claim the applied delta was verified. Record every gate command and result
with the update action.

Mark the plan implemented without asking when the winner's validated review is `acceptable`, the
apply succeeded, and at least one main-tree gate was identifiable and every gate that ran exited
zero, the heavy stage included:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented --json <slotArg>
```

Report a marker failure but never fail the run. When no host gate is identifiable, do not mark the
plan and say so. Record the outcome in `handBack.markedImplemented` (the returned `implementedAt`,
or `null` with a bounded failure or skip note), then use the complete action as the last state
write; any other terminal hand-back or discard outcome completes the record without a marker.

The final report includes:

- the lineup source and the source of `c1`, the plan slot, the recorded `userOwnedSteps`, and every
  contestant's label, route, model, effort, job id, thread id, status, and review verdict, plus the
  Claude invocation note for every Claude contestant and Claude reviewer ("Final report lines")
- which decisiveness rule fired, whether it selected automatically or asked and why, the winner and
  its evidence, and every alternative with its verdict, identical-delta notes, and deviations
- the hand-back result — automatic or user-confirmed, `staged, not committed` on success, every
  conflicted path on failure, the plan-marker result, and for an automatic success the applied
  paths and revert instructions
- every retained worktree with its removal command, every patch path, and every cleanup failure
- every main-tree gate command and exit result labeled `authoritative host gates`, or that gates did
  not run without a successful apply; contestant self-reports keep their
  `contestant-reported checks` label
- the usage line for every implementer and reviewer invocation

State the cost plainly: one concurrent write job per contestant, then one review per non-empty
completed contestant, so both providers' usage can be materially higher than `/stereo:implement`.
Report whether the record is complete or resumable with `/stereo:tournament --resume`, print the
durable `tournament-state.json` path, and name `tournament-state --clear` as the explicit reset.
Repeat that no implementation record was written. Point to `/stereo:implement --review-only` for a
fresh gate on the applied delta and to `/stereo:doctor` to find a worktree stranded by a crash.
Never commit or push.
