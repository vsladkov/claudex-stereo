---
description: Implement or review the stored plan with independently selected Claude or Codex role models
argument-hint: '[--implement-only|--review-only] [--resume] [--isolated] [--base <ref>] [--slot <name>] [--implementer <model>] [--implementer-effort <effort>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <effort>] [--max-fix-rounds <n>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(npm:*), Bash(git:*), Bash(npx:*), Bash(pnpm:*), Bash(yarn:*), Bash(dotnet:*), Bash(cargo:*), Bash(go:*), Bash(make:*), Bash(python3:*), Bash(pytest:*), Bash(mvn:*), Bash(gradle:*), AskUserQuestion
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md`, then
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/pair-procedures.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/implement-procedures.md` — plus
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/worktree-procedure.md` for an `--isolated` run or the
resume of an isolated record — and apply their rules. The rules below are step-specific; a quoted
heading names the section of a routing file that defines the step.

Run the implementation phase of the Stereo workflow. The main Claude session owns preflight,
baselines, host verification, review/fix orchestration, and the final report.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and modes

Parse all arguments per "Selection and effort parsing" before loading state, then read the
"Workspace role defaults" and say in the final effective-role note when a workspace default
supplied the implementer:

- `--implementer <model>` and `--implementer-effort <effort>` select the implementer and its
  effort.
- `--implementation-reviewer <model>` and `--implementation-reviewer-effort <effort>` select the
  implementation reviewer and its effort. Its built-in default is a Codex model: the
  implementation review is the last gate before commit, and the cross-ecosystem reviewer is
  independent of both the orchestrator and the default Claude implementer. `claude:session` is the
  cheaper inline choice.
- `--max-fix-rounds <n>` defaults to 4. Direct gate-fix turns and review-driven fix turns both
  count toward it; the implementer's own inner-loop iterations never do.
- `--slot <name>` selects the stored plan to implement and defaults to `default`.
- `--implement-only` implements and verifies once, then stops before review.
- `--review-only` reviews the current dirty/untracked implementation delta once without fixing.
- `--base <ref>` reviews the committed `<ref>...HEAD` range and is valid only with
  `--review-only`.
- `--resume` re-enters a recorded incomplete implementation phase after a crashed, compacted, or
  closed Claude session.
- `--isolated` runs implementation in a throwaway detached git worktree and hands the delta back
  as a user-confirmed patch.
- Without a mode flag, run the complete implement-plus-review/fix phase.

Reject positionals and both mode flags together. Reject `--fresh`: the implementer always starts
fresh. For `--review-only`, reject `--implementer`, `--implementer-effort`, and `--max-fix-rounds`.
For `--implement-only`, reject `--implementation-reviewer`, `--implementation-reviewer-effort`, and
`--max-fix-rounds`. Reject `--base` without `--review-only`, and reject `--scope` in every mode,
naming `--base <ref>` as the supported standalone range control: auto-detecting a default base
could silently review commits the plan never covered. Reject `--isolated` with `--review-only` and
with `--base`.

Reject `--resume` with `--implement-only`, `--review-only`, `--implementer`, `--implementer-effort`,
or `--slot`: the durable record owns the implementer and the plan slot, so tell the user to run
without `--resume` to start over. `--implementation-reviewer`, `--implementation-reviewer-effort`,
and `--max-fix-rounds` stay legal with it. A bare `--resume` against an isolated record resumes in
its recorded worktree and says so; reject `--isolated --resume` against a non-isolated record and
tell the user to run without `--resume` to start an isolated phase. On resume, the recorded
implementer — its `launchArgs` and `userOwnedSteps` — stays fixed for later fixes, while the
implementation reviewer is resolved, granted, and pinned afresh ("Pinned selections"); its recorded
selection is historical context.

Inside the full fix loop, act on findings automatically. The stop-after-review rule applies to
`--review-only` and explicit safeguard decisions.

## Common stored-plan preflight

For `--resume`, use **Resuming an interrupted phase** instead; do not ask the fresh-phase
`implementedAt` questions before inspecting the implementation record. Otherwise load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
```

If `available` is false, run `plan-state --list --json`. If other slots hold plans, name them and
tell the user to rerun `/stereo:implement --slot <name>`; otherwise stop and tell the user to run
`/stereo:plan`. Retain the stored `findings` array as `storedPlanFindings`, treating a missing or
non-array value as empty.

If `implementedAt` is present, show it and ask exactly once before continuing:

- `Re-implement the same plan anyway`
- `Run /stereo:plan first (Recommended)`
- `Stop here`

The marker means a full implementation phase completed with an accepted review, not that the work
was committed or merged.

If the stored verdict is not `approve`, ask once:

- `Run /stereo:plan first (Recommended)`
- `Implement/review the unapproved plan anyway`
- `Stop here`

Show the slot, summary, verdict, round (including round 0 for a draft), `updatedAt`,
`implementedAt` when present, reviewer label when present, whether residual risks exist, and the
stored finding count. Mention `/stereo:plan-state` for the complete plan.

## Standalone implementation-review step

For `--review-only --base <ref>`, the committed range is the delta:

1. Verify the ref with `git rev-parse --verify '<ref>^{commit}'`; stop and report the resolution
   error if it does not resolve.
2. Set `mergeBase` from `git merge-base '<ref>' HEAD`. Collect `git diff '<mergeBase>..HEAD'` and
   `git log --oneline '<mergeBase>..HEAD'`; this has the same three-dot semantics as branch review,
   excluding commits that exist only on `<ref>`.
3. If `git diff --name-only '<mergeBase>..HEAD'` is empty, stop with
   `Nothing to review: <ref>...HEAD is empty.`
4. Read `git status --porcelain=v1 --untracked-files=all`. The committed `mergeBase..HEAD` diff is
   reviewed in full, including files that are also dirty on disk. Only uncommitted working-tree
   content is out of scope: list every dirty/untracked path in `{{BASELINE_CONTEXT}}`, tell the
   reviewer not to judge those uncommitted changes, and warn when a dirty path also appears in the
   committed range because the file on disk differs from the reviewed committed content.
5. Attribute the entire committed range; apply no baseline-dirty exclusion.
6. Run the fast stage ("Staged verification") on the working tree as it stands and label every
   result `working-tree results`: the checks ran over uncommitted content the review excludes, so
   they are evidence about the tree, not about the committed range alone.

For `--review-only` without `--base`, the whole dirty and untracked worktree is the delta against
`HEAD`: record `baselineCommit = HEAD`, read `git status --porcelain=v1 --untracked-files=all`,
stop with `Nothing to review.` when it is clean, and run the fast stage, labeling its results
`authoritative host gates`.

Derive the reviewer's commands and pin it as step 3 of "Implementation preflight" does, then run
exactly one round of "Implementation review rounds" — no loop and no `<isolationArgs>` — with these
fills: `{{PLAN_INPUT}}` = the full stored plan; `{{BASELINE_CONTEXT}}` = this mode's attribution
statement (for the worktree mode, the recorded HEAD, status, diff, and untracked-file inventory,
saying explicitly not to apply the normal baseline-dirty exclusion; for `--base`, the resolved ref,
`mergeBase`, complete committed range, log, dirty/untracked inventory, and the uncommitted-content
exclusion and overlap warnings above); `{{REVIEW_CONTEXT}}` = `This is a standalone implementation
review. There is no implementer report and there are no prior implementation-review rounds.`,
followed by `storedPlanFindings` verbatim when non-empty under the same advisory or
known-unapproved label as round 1; `{{HOST_RESULTS}}` = the fast-stage results under this mode's
label; `{{GRANTED_COMMANDS}}` = as for a loop round. A review job that fails or is cancelled is
relaunched fresh or the run stops, since there is no implementation state to record. Report the
exact `{acceptable, summary, fixes}` result, the host checks, and the reviewer's usage line (with
the Claude invocation note for a Claude reviewer), then stop without fixing or storing
implementation state.

## Implementation state record

The durable workspace record lets an incomplete implementation/review/fix phase survive a crashed,
compacted, or closed Claude session. Only `/stereo:implement` writes it; it lives beside the stored
plan under the workspace's `$CODEX_HOME/companion-state/<workspaceKey>/` directory. One
implementation phase per workspace is assumed: a fresh `--record` replaces any older record, and
concurrent implementations are last-write-wins. Write `<statePayloadFile>` under "Quoting" and use
these subactions:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --record --state-file '<statePayloadFile>' --json <slotArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --update --state-file '<statePayloadFile>' --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --complete --state-file '<statePayloadFile>' --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --clear --json
```

The record carries `baselineCommit`, the baseline-dirty paths, `baselineGateSnapshot` (the per-gate
command, exit status, and bounded output tail recorded before the implementer launched), `fixTurns`
(every direct gate-fix or review-driven fix turn dispatched this phase), `gateFixEpisodes` (a
bounded array of per-episode entries: gates, classification, turns used, outcome; a review-driven
turn's entry records empty gates, classification `review-driven`, and the driving fix numbers),
`implementationThreadId`, `jobId` (the latest implementation or fix background job, replaced at
every launch), the implementer's selection, model, and route, `launchArgs` ("Implementer launches
and payloads"), `userOwnedSteps` (`[]` when none), the implementation-reviewer selection, `mode`,
`maxFixRounds`, `round`, `latestVerdict` (the latest review's verdict, sent with every post-review
update), and `rounds[]`. Fields omitted from an update patch are retained, and a sent non-`rounds`
field replaces the recorded value wholesale — so an update that changes `gateFixEpisodes` carries
the complete array, while one that does not touch it omits it. An isolated record also carries
`isolated: true` and
`worktree: { "path": "<worktreePath>", "removeCommand": "<removeCommand>", "baselineCommit": "<baselineCommit>", "provisioning": "<symlink|install|unprovisioned>" }`.
Every round entry stores its review number in `review` and contains numbered fixes with the latest
`resolved`/`unresolved` judgment plus bounded implementer-report and host-result summaries;
`--update` and `--complete` merge supplied `rounds[]` entries by that review number, so resending a
round is idempotent. The companion adds `status` (`in-progress` until `--complete`), the timestamps,
and the stored plan's snapshot with its fingerprint. Store bounded summaries rather than verbatim
reports and keep the payload below 512 KiB; the companion rejects larger files. Read the current
record with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --json
```

Every state-write failure is reported but does not fail implementation, verification, or review.

## Implementation preflight

For the full phase or `--implement-only`, run "Implementation preflight" over the stored plan —
pinning the implementation reviewer too outside `--implement-only` — and record its snapshot as
`baselineGateSnapshot`. In isolated mode, create the worktree after the scan and the pins.

Then write the initial launch record with `implement-state --record`, so no partially initialized
record ever exists and the record always carries the post-scan implementer: every field above with
`round: 0`, `rounds: []`, `fixTurns: 0`, `gateFixEpisodes: []`, the `baselineGateSnapshot`, the
scan's `userOwnedSteps`, the pinned `launchArgs`, and no implementation thread, job, or
`latestVerdict` yet. This applies to `--implement-only` too, so an interrupted implement-only launch
can later resume at review round 1. Report a write failure and continue.

## Isolated worktree mode

For a fresh `--isolated` run and for `--resume` of an isolated record, follow "Isolated worktrees"
with these points:

1. **Durable fields.** Add `isolated: true` and the `worktree` object above to the initial
   `--record` payload, written after the in-worktree snapshot; both survive later patches.
2. **Terminal exits.** Hand the delta back at every terminal exit — accepted full phase,
   `--implement-only` stop, safeguard stop, or max-rounds stop.
3. **Lifecycle.** It follows the hand-back choice. Applied (or empty) with a green authoritative
   main-tree rerun: run `implement-state --complete`, and add `plan-state --mark-implemented` only
   when this terminal exit is the accepted full phase. Applied with a red rerun:
   `implement-state --complete` with the failing-gate summary and a not-verified note, no marker,
   and the staged delta left in place with named follow-ups. Discarded: `implement-state --complete`
   recording the delta as discarded, never marked implemented. Leave-for-me: keep the record
   in progress — the only resumable terminal choice.

## Implementation routing

Launch the implementer with the fresh line of "Implementer launches and payloads": the approved
variant normally and the unapproved one only after the preflight gate. Fill the shared payload with
the full stored plan verbatim and `storedPlanFindings` — the advisory block on an approved plan,
the latest-findings block on an unapproved one, only when the array is non-empty.

Immediately after every implementation, retry, or fix launch, update the record with that launch's
`jobId`, so resume checks the worker most recently responsible for the delta, and after each fetch
record the saved `implementationThreadId`. After every launch, follow that section's checks and its
one fresh retry. A job that fails or is cancelled follows "Failed and cancelled jobs": the record
already carries its `jobId` and keeps the last completed turn (its completed rounds, fix
judgments, and the pending episode entry), so a stop leaves the record in progress and
`/stereo:implement --resume` re-enters it later, closing the pending episode from the job's
recorded outcome.

## Host verification and implement-only stop

Verify per "Staged verification" after every implementer turn. For `--implement-only`, run the
route-dependent verification and the classification, then stop without dispatching any fix turn.
Report the attributed delta, selected implementer, verification results itemized under their
labels, red-gate classifications, deviations, user-owned steps, and every implementer invocation's
usage line. Outside isolated mode the record stays in progress: say so, and say that
`/stereo:implement --resume` re-enters it at review round 1 and `implement-state --clear` discards
it; in isolated mode the hand-back lifecycle decides. Point to `/stereo:implement --review-only`
and stop.

## Gate-fix accounting

Before dispatching any fix turn — direct or review-driven — increment `fixTurns` and append a
pending `gateFixEpisodes` entry with `implement-state --update`, folding in any adjacent round
entry so one write covers both; replace the pending entry with the outcome once the turn
completes. Every episode-touching update carries the complete episodes array.

## Full implementation-review and fix loop

Run every round per "Implementation review rounds", with `storedPlanFindings` as the plan-review
findings (advisory when the stored verdict is `approve`, known unapproved findings otherwise). A
review job that fails or is cancelled leaves the record with the last completed round;
`/stereo:implement --resume` re-reviews the actual delta later.

Update the record after every review with `round` equal to the number of completed review rounds,
the numbered fixes and their latest judgments, `latestVerdict`, and bounded implementer-report and
host-result summaries. If acceptable, carry that final round entry in the `--complete` payload and
finish. Otherwise fold the round entry, the incremented `fixTurns`, and the pending episode entry
into one pre-dispatch update, then send the fixes as that section describes. After the fix and
fresh verification, update the round entry with bounded reports and judgments without incrementing
`round`; that field counts completed review rounds, so a crash after fixes resumes by
re-reviewing the actual delta.

When `fixTurns` reaches `--max-fix-rounds`, or when substantially the same issue survives three
rounds, ask the cap question "Implementation review rounds" defines.

After the accepted review and a green (or absent) heavy stage, and before the final report, run both
lifecycle writes (in isolated mode, defer them to the hand-back lifecycle):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented --json <slotArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --complete --state-file '<statePayloadFile>' --json
```

The completion payload contains the accepted final review summary, final round, and latest host
summary. Report a failure to set either marker but never fail the run because of it. A pre-existing
or undiagnosable heavy red completes the record with the failing-gate summary and skips the plan
marker. `--implement-only` and `--review-only` never mark the plan implemented.

## Resuming an interrupted phase

For `--resume`, do not create a new baseline or launch an implementer before completing these
checks:

1. Run `implement-state --json`. When `unreadable` is true (it also reports `available: false`),
   report its `path` and `parseError`, then stop. If `available` is false, stop and direct the user
   to run `/stereo:implement` without `--resume`. If the record status is `complete`, report its
   round, verdict, and `completedAt`, then ask exactly once whether to start a fresh phase, clear
   the record and stop, or stop without changing it. A record without `launchArgs` was written by
   an earlier release and cannot be resumed: say so, report its worktree path when it is isolated
   (`implement-state --clear` and `/stereo:doctor` print its removal command), and ask exactly once
   whether to clear it and start a fresh phase or stop without changing it.
2. For an isolated record, announce that the bare resume uses the recorded worktree. Require a
   non-empty absolute `worktree.path`, verify that it is still a directory and appears exactly as a
   `worktree` line of `git -C '<mainRoot>' worktree list --porcelain`, and reuse it as
   `<worktreePath>` (with `worktree.removeCommand` as `<removeCommand>`). When either check fails,
   report the recorded path, explain that the isolated delta is no longer recoverable from the
   record, and offer `implement-state --clear` followed by a fresh `/stereo:implement --isolated`;
   launch nothing.
3. Take the recorded slot from the payload's top-level `plan.slot`, announce it, set `<slotArg>`
   from it, and run `plan-state --json <slotArg>`. If unavailable, stop. When `planMatches` is
   false, show both recorded and current plan fingerprints and timestamps, warn that
   `{{PLAN_INPUT}}` will use the current stored plan, and ask exactly once whether to continue or
   stop.
4. Check the recorded worker before inspecting a possibly partial delta. List every session's jobs
   in this workspace with `status --json --all` and treat a write job newer than the recorded
   `jobId` as the active worker (the same wait-or-stop question below) — a crash inside the dispatch
   window leaves the record one launch behind — closing the pending episode from its outcome. When
   `jobId` exists, run `status <jobId> --json` first:
   - For `queued` or `running`, report its phase and elapsed time and ask exactly once whether to
     wait (the polls of "Companion background jobs") or stop and leave it running; once terminal,
     fetch its result and continue.
   - For `completed`, fetch `result <jobId> --json` and use `storedJob.result.rawOutput` as the
     latest implementer or fix-turn report in `{{REVIEW_CONTEXT}}`, labeled from the record's round
     and episode state — the job most recently responsible for the delta may be a fix launch.
   - For `failed`, `cancelled`, or an unknown id, report the condition and continue with the
     recorded state.
5. Compare HEAD — `git rev-parse HEAD`, or `git -C '<worktreePath>' rev-parse HEAD` for an isolated
   record — with the recorded `baselineCommit`. When equal, resume normally. When HEAD moved,
   verify the baseline with `git cat-file -e '<baselineCommit>^{commit}'` against the same target;
   if it resolves and a delta exists, report the move, retain that baseline for attribution, and ask
   exactly once whether to continue or stop. If it no longer resolves, stop as stale, explain why
   attribution is impossible, and offer `implement-state --clear`. When no attributed delta exists
   beyond the recorded baseline-dirty paths, report that the work is gone and ask whether to clear
   and restart or stop.
6. Re-inspect the actual status, diff, every changed/untracked file, and baseline-dirty exclusions,
   and rerun the complete fast stage; recorded host results are historical summaries, never current
   evidence. Classify every red against the recorded `baselineGateSnapshot` and feed the gate-fix
   pre-loop.
7. An isolated record whose `latestVerdict` is acceptable is an accepted phase awaiting hand-back:
   re-verify the worktree (the containment guard plus the step-6 gates) and resume directly at the
   hand-back question. Otherwise re-enter at review round `record.round + 1` (round 0 resumes at
   round 1), using the report fetched in step 4 when available, else labeling the implementer
   report unavailable or a stored pre-resume summary.
8. Rebuild `{{REVIEW_CONTEXT}}` from `record.rounds`: retain round-1 context, every prior numbered
   fix and its latest judgment, and label stored reports as pre-resume summaries.
9. Fixes use the recorded `launchArgs` and `implementationThreadId` ("Implementer launches and
   payloads"), never the current workspace defaults; a fresh relaunch embeds the complete current
   plan, every numbered fix, and the recorded `userOwnedSteps`.
10. `--max-fix-rounds` counts recorded work too: resume the cap from recorded `fixTurns` plus
    session-observed turns, and rebuild episode context from `gateFixEpisodes` labeled as
    pre-resume history. Close any still-pending episode entry from the step-4 job outcome when it
    exists, else mark it `interrupted`. An explicit flag overrides recorded `maxFixRounds`. If the
    record already reached the effective cap, ask the safeguard question before another round.

After these checks, use the normal full review/fix loop and state updates. Resume never reuses
recorded host results as proof and never assumes conversation history survived.

## Final report

Name the implemented plan slot. Report selected roles, every fix turn (direct gate-fix and
review-driven, with the gates or findings that drove it), attributed files, the verification
lines, every pre-existing or unattributable red and its disposition, deviations, user-owned
steps, all stored open questions and residual risks, and, per "Final report lines", the usage
line for every implementer, fix, and reviewer turn, the Claude invocation note for every Claude
turn, the thread line for `implementationThreadId` (with `implementationReviewThreadId` labeled by
role), the isolated-run lines for an isolated run, and the commit line.

Report the durable record's final lifecycle: a fully accepted phase marks it complete, while an
interrupted phase remains available through `/stereo:implement --resume`. For
`--review-only --base`, repeat that the committed range was reviewed in full and list uncommitted
dirty/untracked paths as out of scope, including every range/dirty overlap warning.
