---
description: Implement or review the stored plan with independently selected Claude or Codex role models
argument-hint: '[--implement-only|--review-only] [--resume] [--isolated] [--base <ref>] [--slot <name>] [--implementer <model>] [--implementer-effort <none|minimal|low|medium|high|xhigh|max>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-fix-rounds <n>] [--fresh]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(node:*), Bash(npm:*), Bash(git:*), Bash(npx:*), Bash(pnpm:*), Bash(yarn:*), Bash(dotnet:*), Bash(cargo:*), Bash(go:*), Bash(make:*), Bash(python3:*), Bash(pytest:*), Bash(mvn:*), Bash(gradle:*), AskUserQuestion, Agent
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md` and apply its routing, foreground
agent, validation, quoting, and background-job rules. The rules below are step-specific.

Run the implementation phase of the Stereo workflow. The main Claude session owns preflight,
baselines, host verification, review/fix orchestration, and the final report.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and modes

After reading the routing skill, parse all arguments before loading state:

- `--implementer <model>` selects the implementer. Resolve it as explicit flag > workspace
  `implementer` default > `claude:opus`.
- `--implementer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed implementer.
- `--implementation-reviewer <model>` selects the implementation reviewer. Resolve it as explicit
  flag > workspace `implementationReviewer` default > `codex:sol`: the implementation review is
  the last gate before commit, and the cross-ecosystem reviewer is independent of both the
  orchestrator and the Claude-routed default implementer that produced the delta.
  `claude:session` remains valid and is the cheaper inline choice.
- `--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort
  for a Codex-routed implementation reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for
  Codex-routed roles that have no role effort flag.
  When no active role is Codex-routed, a command-wide `--effort` is inert: accept it, report it as
  inert, and never translate it into a Claude-side control.
- `--max-fix-rounds <n>` defaults to 4. Direct gate-fix turns and review-driven fix turns both
  count toward it; the implementer's own inner-loop iterations never do.
- `--slot <name>` selects the stored plan to implement and defaults to `default`.
- `--fresh` skips a reusable stored Codex plan-review thread; it only affects a Codex-routed
  implementer and is accepted but reported as inert for a Claude-routed one.
- `--implement-only` implements and verifies once, then stops before review.
- `--review-only` reviews the current dirty/untracked implementation delta once without fixing.
- `--resume` re-enters a recorded incomplete implementation phase after a crashed, compacted, or
  closed Claude session.
- `--isolated` runs implementation in a throwaway detached git worktree outside the repository
  and hands the delta back as a user-confirmed patch. It never commits and never writes in the
  main working tree.
- `--base <ref>` reviews the committed `<ref>...HEAD` range and is valid only with
  `--review-only`.
- Without a mode flag, run the complete implement-plus-review/fix phase.

Define `<slotArg>` as `--slot <slot>` for a non-default target slot and omit it entirely for the
`default` slot. On `--resume`, replace it with the slot owned by the durable implementation record.

Reject missing values, duplicates, positionals, invalid effort/round values, unknown flags,
unknown `claude:*` values, and both mode flags together. Accept `claude:inherit` alongside
`claude:session` and the four explicit Claude aliases. Accept a Codex selection with or without
the `codex:` prefix and reject `codex:claude:*`. The removed implementer `--model` and `--review-model`
flags are unknown; report the role-named replacements.
The renamed `--impl-reviewer` and `--impl-reviewer-effort` flags are unknown; report
`--implementation-reviewer` and `--implementation-reviewer-effort` as their replacements.

For `--review-only`, reject `--implementer`, `--implementer-effort`, `--fresh`, and
`--max-fix-rounds`. For `--implement-only`, reject `--implementation-reviewer`,
`--implementation-reviewer-effort`, and `--max-fix-rounds`. Reject a role effort flag when its
selected role is Claude-routed.

Reject `--resume` with `--implement-only`, `--review-only`, or `--fresh`. Reject `--resume` with
`--implementer` or `--implementer-effort`: the durable record owns the implementer; tell the user
to run without `--resume` to start over. Reject `--resume` with `--slot`: the durable record owns
the plan slot; tell the user to run without `--resume` to start over. `--implementation-reviewer`,
`--implementation-reviewer-effort`, `--effort`, and `--max-fix-rounds` remain legal with
`--resume`. Reject `--base` without `--review-only`. Reject `--scope` in every mode and name
`--base <ref>` as the supported standalone range control: auto-detecting a default base could
silently review commits the plan never covered.

Reject `--isolated` with `--review-only` and with `--base`. It remains legal with
`--implement-only` and `--resume`. On `--resume`, the durable record is authoritative: a bare
`--resume` against an isolated record resumes in its recorded worktree and says so. Reject
`--isolated --resume` against a non-isolated record and tell the user to run without `--resume` to
start a new isolated phase.

On resume, the recorded implementer model and effort remain fixed for later fixes. Re-resolve the
implementation reviewer through the normal reviewer flag/workspace/default precedence; its
recorded selection is historical context, and the legal reviewer/effort flags may choose a new
reviewer for this command run.

Reject `claude:session` as the implementer; Claude writes must use the contained named agent.

Stored-plan `model`/`effort` are the last Codex pair values recorded for the plan; they survive a
Claude-side persist and never resolve the implementer. Resolve the model as `--implementer` >
workspace `implementer` default > `claude:opus`. For a Codex-routed implementer, resolve effort as
`--implementer-effort` > command-wide `--effort` > workspace implementer effort default > the
selected model's pair default; stored-plan effort belongs to the stored model and is never
borrowed by a different selection. Omit a null effort. A Codex-routed implementer resumes
`storedPlanReviewThreadId` per the implementation-routing rules below only when it is the model
that produced that thread. For a Codex implementation reviewer, resolve `--implementation-reviewer-effort` >
command-wide `--effort` > workspace implementation-reviewer effort > the routing skill's pair
default.

A delta is never gated by the model that produced it: when the resolved implementer and
implementation reviewer are the same model and the reviewer came from the built-in default
rather than a flag or workspace default, substitute the other ecosystem's review default —
`codex:sol` for a Claude-routed implementer, `claude:fable` for a Codex-routed one — and report
the substitution. A same-model reviewer selected by an explicit
`--implementation-reviewer` flag or a stored workspace default is honored but called out as
self-review in the recap and the final report.

Inside the full fix loop, act on findings automatically. The stop-after-review rule applies to
`--review-only` and explicit safeguard decisions.

## Workspace role defaults

Before the stored-plan preflight, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --json
```

Apply the routing skill's "Workspace role defaults" mechanics to the result. When a workspace
default supplies the implementer, say so in the final effective-role note.

## Common stored-plan preflight

For `--resume`, use the ordered checks in **Resuming an interrupted phase** instead of this fresh
phase preflight; that flow loads both records, detects plan drift, and then returns to the normal
review/fix loop. Do not ask the fresh-phase `implementedAt` questions before inspecting the
implementation record.

Load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
```

If `available` is false, run `plan-state --list --json`. If other slots hold plans, name them and
tell the user to rerun `/stereo:implement --slot <name>`; otherwise stop and tell the user to run
`/stereo:plan`. Include the selected slot in the stored-plan summary. Save a non-null stored thread
only as `storedPlanReviewThreadId`, never as an implementation thread.
The stored `model` and `effort` are the last Codex pair values recorded for this stored plan and
survive a Claude-side persist. A stored review thread survives only when the persisting command
passed it through explicitly.
Retain the stored `findings` array as `storedPlanFindings`, treating a missing or non-array value
as empty.

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

Show the summary, verdict, round (including round 0 for a draft), `updatedAt`, `implementedAt` when
present, reviewer label when present, whether residual risks exist, and the stored finding count
(treat missing or non-array `findings` as zero). Mention `/stereo:plan-state` for the complete plan.

## Standalone implementation-review step

For `--review-only --base <ref>`, replace the normal standalone steps with this committed-range
flow:

1. Verify the ref with `git rev-parse --verify <ref>^{commit}`. Stop and report the resolution
   error if it does not resolve.
2. Set `mergeBase` from `git merge-base <ref> HEAD`. Collect `git diff <mergeBase>..HEAD` and
   `git log --oneline <mergeBase>..HEAD`; this has the same three-dot semantics as branch review,
   excluding commits that exist only on `<ref>`.
3. If `git diff --name-only <mergeBase>..HEAD` is empty, stop with
   `Nothing to review: <ref>...HEAD is empty.`
4. Read `git status --porcelain=v1 --untracked-files=all`. The committed `mergeBase..HEAD` diff is
   reviewed in full, including files that are also dirty on disk. Only uncommitted working-tree
   content is out of scope: record and list every dirty/untracked path in `{{BASELINE_CONTEXT}}`,
   tell the reviewer not to judge those uncommitted changes, and warn when a dirty path also
   appears in the committed range because the file on disk differs from the reviewed committed
   content. Repeat this exclusion in the final report.
5. Attribute the entire committed range. Do not apply the baseline-dirty exclusion and do not
   filter range files merely because they are dirty on disk.
6. Run the fast stage and build the brief through the unchanged
   routing below. This mode does not fix or store implementation state.

For `--review-only` without `--base`, do not use the normal phase attribution rule:

1. Record `baselineCommit = HEAD`.
2. Read `git status --porcelain=v1 --untracked-files=all`.
3. Treat every current dirty and untracked path as the implementation delta.
4. If the worktree is clean, stop with `Nothing to review.`
5. Run the fast stage and record every command and exit result.
6. Build review input from the full stored plan, `HEAD`, current status/diff, every untracked file,
   the host-check results, and `storedPlanFindings`.

Read `${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md` and fill it once without changing
any other text:

- `{{PLAN_INPUT}}` = the full stored plan.
- `{{BASELINE_CONTEXT}}` = for worktree mode, the literal standalone-review rule that the entire
  current dirty and untracked worktree is the delta against `HEAD`, with the recorded HEAD,
  status, diff, and untracked-file inventory. Explicitly say not to apply the normal
  baseline-dirty exclusion. For `--base`, provide the resolved ref, `mergeBase`, complete committed
  range, log, dirty/untracked inventory, and the explicit uncommitted-content exclusion and
  overlap warnings above.
- `{{REVIEW_CONTEXT}}` = `This is a standalone implementation review. There is no implementer
report and there are no prior implementation-review rounds.` Append `storedPlanFindings` verbatim
  when non-empty, labeled as "Advisory findings from the approving plan review, context only: the
  approved plan takes precedence, and the reviewer must not report a fix solely because an
  advisory finding was not adopted" when the stored verdict is `approve` and as known unapproved
  findings otherwise.
- `{{HOST_RESULTS}}` = every named fast-stage command and its exact exit result/output
  summary, labeled `authoritative host gates`.

The result is the single `implementationReviewBrief` for every route.

Route exactly one review through `--implementation-reviewer`:

- `claude:session`: apply `implementationReviewBrief` inline to the complete delta.
- Named Claude: use `implementationReviewBrief` verbatim as the routing skill's
  `stereo:implementation-reviewer` prompt.
- Codex: write `implementationReviewBrief` verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, launch one fresh read-only task, and save its thread only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" --prompt-file "<payloadFile>"
```

Validate through the routing skill, including the acceptable/fixes coupling and one retry. A
Codex retry preserves the same `--output-schema` flag. Report the exact
`{acceptable, summary, fixes}` result, host checks, and reviewer per-invocation usage and duration
(or `usage unavailable`), then stop. Do not fix or store implementation state.

## Implementation state record

The durable workspace record lets an incomplete implementation/review/fix phase survive a
crashed, compacted, or closed Claude session. Only `/stereo:implement` writes it; it lives beside
the stored plan under the workspace's `$CODEX_HOME/companion-state/<workspaceKey>/` directory.
One implementation phase per workspace is assumed. A fresh `--record` deliberately replaces any
older record, and concurrent implementations are last-write-wins.

Use the companion subactions exactly as follows. Create `<statePayloadFile>` with the Write tool
under the routing skill's temporary-directory and quoting rules; never deliver record JSON through
the shell:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --record --state-file "<statePayloadFile>" --json <slotArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --update --state-file "<statePayloadFile>" --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --complete --state-file "<statePayloadFile>" --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --clear --json
```

The record carries `baselineCommit`, the baseline-dirty paths, `baselineGateSnapshot` (the
per-gate command, exit status, and bounded output tail recorded before the implementer launched),
`fixTurns` (every direct gate-fix or review-driven fix turn dispatched this phase),
`gateFixEpisodes` (a bounded array of per-episode entries: gates, classification, turns used,
outcome; a review-driven turn's entry records empty gates, classification `review-driven`, and
the driving fix numbers), `implementationThreadId`, `jobId`
(the launched implementation or fix background job, replaced at every launch), implementer
selection/model/effort/route, implementation-reviewer selection, `mode`, `maxFixRounds`, `round`,
and `rounds[]`. Fields omitted from an update patch are retained, and a sent non-`rounds` field
replaces the recorded value wholesale — so an update that changes `gateFixEpisodes` must carry
the complete array, while an update that does not touch it omits it. An isolated record
additionally carries `isolated: true` and
`worktree: { "path": "<worktreePath>", "baselineCommit": "<baselineCommit>", "provisioning": "<symlink|install|unprovisioned>" }`;
a legacy record without the provisioning field re-derives it by testing for
`<worktreePath>/node_modules`. Every round entry
stores its review number in `review` and contains numbered fixes with the latest
`resolved`/`unresolved` judgment plus bounded implementer-report and host-result summaries.
`implement-state --update` and `--complete` merge supplied `rounds[]` entries by that review number,
replacing the recorded entry instead of appending, so resending a round is idempotent; `round` is
accepted as a legacy alias. The record also carries `latestVerdict`, `status`, timestamps, and the
plan fingerprint snapshot added by the CLI. Store bounded summaries rather than verbatim reports
and keep the complete payload below 512 KiB; the companion rejects larger files instead of
truncating them silently.

Read the current record with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --json
```

Every state-write failure is reported but does not fail implementation, verification, or review.

## Implementation preflight

For the full phase or `--implement-only`, record:

- `baselineCommit` from `git rev-parse HEAD`.
- The exact paths from `git status --porcelain=v1 --untracked-files=all`.

If dirty, ask whether to stop so the user can commit/stash (recommended) or continue. Preserve the
baseline-dirty list for attribution and rollback. In isolated mode, use the expanded question in
**Isolated worktree mode** instead of asking twice. If the stop-time review gate is enabled,
mention that completion triggers an additional Codex review and how to disable it during long
pair runs.

Resolve the implementer next, before any paid preflight work, so its free filter can gate what
follows. If the selected implementer is Claude, scan the stored plan's `## Step-by-step changes`
for commands outside the implementer's build/test/static-check scope: version bumps, package
installation, code generation the repository's gates do not already run, migrations, network
access, or interactive/long-running processes. If present, ask:

- Switch to the command-capable `codex:sol` implementer with the user's effort or `max`
  (recommended).
- Continue and leave each out-of-scope command step user-owned.
- Stop.

Record every user-owned step. The Claude implementer builds and tests inside its own turn but
never runs the excluded command classes, and the orchestrator never executes shell text on an
agent's behalf. A switch chosen here resolves the implementer before anything below runs, so the
snapshot is never wasted on a stopped run and the record never carries a stale implementer.

Then take the baseline gate snapshot, risk-matched to what it protects: always run the fast
stage's static checks (for this repository `npm run typecheck`, `npm run lint`,
`npm run format:check`, and `npm run check-version`), run the unit suite only when the baseline is
dirty, and never run the heavy stage. Snapshot gates may run concurrently where the host affords
it, like the fast stage. Record each gate's command, exit status, and a bounded
output tail as `baselineGateSnapshot`. The snapshot is what makes post-implementation attribution
possible; a gate that was never snapshotted can only produce unattributable reds. In isolated
mode, the snapshot must describe the tree the pre-loop will classify: take it in the worktree
after provisioning, per **Isolated worktree mode**, not on the main tree.

After recording the baseline, resolving the implementer through the scan, and taking the gate
snapshot, write the
initial launch record with
`implement-state --record --state-file "<statePayloadFile>" <slotArg>`, so no partially
initialized record ever exists and the record always carries the post-scan implementer. Include
all fields defined
above, with `round: 0`, `rounds: []`, `fixTurns: 0`, `gateFixEpisodes: []`, the
`baselineGateSnapshot`, `status: in-progress`, and no implementation thread or job
yet. In isolated mode, create the worktree after the scan and include its fields as specified
below. This
applies to the full phase and `--implement-only`, so an interrupted implement-only launch can later
resume at review round 1. Report a write failure and continue.

## Isolated worktree mode

This section applies to a fresh `--isolated` run and to `--resume` when the durable record says
`isolated: true`. Set `<mainRoot>` to `git rev-parse --show-toplevel`. The worktree is detached and
temporary; no command in this flow creates a branch or commit.

1. **Extra preflight.** After recording `baselineCommit` and the baseline-dirty paths, if the main
   tree is dirty, explain that the isolated worktree starts from `HEAD` and therefore does not
   contain those uncommitted changes. Hand-back refuses patched paths that overlap the dirty set.
   Ask exactly once whether to stop and commit/stash (recommended) or continue. If the stop-time
   review gate is enabled, also explain that it reviews the main tree, which remains clean during
   the isolated run, and point to `/stereo:setup --disable-review-gate`.
2. **Creation.** Derive `<repoSlug>` from the basename of `<mainRoot>` by replacing every run of
   characters outside `[A-Za-z0-9._-]` with `-`. Generate a fresh unique `<shortId>` and create the
   worktree only outside the repository working tree:

   ```bash
   git -C "<mainRoot>" worktree add --detach "${TMPDIR:-/tmp}/stereo-worktrees/<repoSlug>-<shortId>" HEAD
   ```

   `git worktree add` creates the missing temporary parent directories. Save the resulting
   absolute path as `<worktreePath>`. Never place it inside `<mainRoot>`. If creation fails, report
   the exact failure and stop without launching an implementer.

3. **Dependency provisioning.** Provision the fresh worktree immediately after creation,
   orchestrator-executed. Symlink the main checkout's installed dependencies when linkable — for
   npm-family repositories:

   ```bash
   node -e "fs.symlinkSync(process.argv[1], process.argv[2], 'junction')" "<mainRoot>/node_modules" "<worktreePath>/node_modules"
   ```

   (`'junction'` degrades to a plain symlink off-Windows; this takes seconds and needs no
   network, but shares the main checkout's mutable caches). If symlink creation fails or sharing
   is unsafe for this repository, fall through to the repository's documented install command
   with worktree-targeted flags — and run it only when the plan actually builds or tests
   artifacts, never speculatively for a document-only plan. Otherwise the worktree stays
   unprovisioned. Record which path was taken and state the worktree's provisioning status in
   every implementer prompt.

   After provisioning, take the baseline gate snapshot here — in the worktree, using the
   worktree-gates step's native or fallback recipes — instead of on the main tree: static gates
   only, since a fresh checkout at `HEAD` is never dirty and the unit suite is therefore never
   snapshotted. A gate the recipes cannot run stays unsnapshotted, so its reds are unattributable,
   consistent with its recorded provenance. The implementation record is still written only after
   this snapshot.

4. **Companion routing.** Define `<isolationArgs>` as empty in every non-isolated run. In isolated
   mode it is:

   ```text
   --cwd "<worktreePath>" --workspace "<mainRoot>"
   ```

   `--cwd` sets the Codex thread cwd, which confines Codex writes to the worktree. `--workspace`
   keeps the job record, log, durable state, and shared broker keyed to the main workspace. Thus
   `/stereo:status`, `/stereo:result`, and `/stereo:cancel` continue to work unchanged from the
   main repository, and no second worktree-keyed broker is started.

5. **Durable fields.** Add `isolated: true` and
   `worktree: { "path": "<worktreePath>", "baselineCommit": "<baselineCommit>" }` to the initial
   `implement-state --record` payload. Both fields survive all later `--update` and `--complete`
   patches.
6. **Post-turn containment guard.** After every implementation or fix turn, run
   `git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all` and compare its exact path set
   with the recorded baseline-dirty set. Any new main-tree path means the implementer wrote outside
   the worktree: stop, report the paths verbatim, and do not continue the loop. Codex-reported
   `touchedFiles` are absolute to the worktree; do not mistake them for main-tree writes.
7. **Review and verification target.** Use `git -C "<worktreePath>" ...` for every diff, status,
   and file inspection. `{{BASELINE_CONTEXT}}` must say that the delta lives in the isolated
   worktree at `<worktreePath>`, provide its `baselineCommit`, and say that fix `file` values remain
   repository-relative and are identical in both trees. For a named-Claude or `claude:session`
   reviewer, provide the absolute worktree path and require inspection with
   `git -C "<worktreePath>"` and absolute Read paths. If the harness denies reads outside the main
   workspace, fall back to the complete diff already embedded in `{{BASELINE_CONTEXT}}` and record
   that limitation in the round note. A contained `stereo:implementer` also receives absolute
   worktree paths for every Edit, Write, and Read operation. If its Edit or Write is denied outside
   the main workspace, stop and report the denial instead of falling back to the main tree.
8. **Worktree gates.** Run repository gates with the worktree as their working directory. A
   provisioned worktree runs the inner loop and the fast stage natively: for npm projects use
   `npm --prefix "<worktreePath>" test`, and the corresponding `npm --prefix` form for every other
   script. An unprovisioned worktree falls back to the main checkout's toolchain per gate,
   expressed through command forms the frontmatter grants cover — for this repository: run the
   format check as
   `node "<mainRoot>/node_modules/prettier/bin/prettier.cjs" --check --ignore-path "<worktreePath>/.gitignore" "<worktreePath>"`;
   run the typecheck by
   generating the codegen output into the worktree and then
   `node "<mainRoot>/node_modules/typescript/bin/tsc" --noEmit -p "<worktreePath>/tsconfig.json" --typeRoots "<mainRoot>/node_modules/@types"`;
   record `lint` as not runnable (its flat config resolves plugins through a local
   `node_modules`). A repo-specific codegen tool (here the `codex` CLI) may still prompt; that is
   inherent to per-repository toolchains. Record per gate whether it ran natively, through the main toolchain, or not at
   all; record anything that cannot run as `not runnable in the isolated worktree`, carry it into
   `{{HOST_RESULTS}}` and the final report, and do not call it passed. Every pre-hand-back result
   is a `provisional worktree check`; the post-hand-back main-tree rerun is authoritative. After a
   confirmed hand-back, rerun the complete fast stage in the main tree before the final report.
9. **Delta hand-back.** At every terminal exit—accepted full phase, `--implement-only` stop,
   safeguard stop, or max-rounds stop—create a patch under the routing skill's temporary-directory
   rule, never inside either repository tree:

   ```bash
   git -C "<worktreePath>" add -N .
   git -C "<worktreePath>" diff --binary --no-ext-diff "<baselineCommit>" > "<patchFile>"
   git -C "<worktreePath>" diff --stat "<baselineCommit>"
   git -C "<worktreePath>" diff --name-only "<baselineCommit>"
   ```

   If the patch is empty, say so and proceed directly to cleanup. Otherwise recompute
   `git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all` and
   `git -C "<mainRoot>" rev-parse HEAD`. Report every overlap between patched paths and currently
   dirty main-tree paths and report when `HEAD` moved from `baselineCommit`. Show the patch stat and
   ask exactly once:

   - `Apply the patch to the working tree (Recommended)`
   - `Leave the patch and the worktree for me`
   - `Discard the worktree without applying`

   When `HEAD` moved, include in that apply question itself that a 3-way merge may conflict. On
   apply, first run `git -C "<mainRoot>" apply --3way --check "<patchFile>"`; only after it succeeds
   run `git -C "<mainRoot>" apply --3way "<patchFile>"`. The check validates pre-images and index
   compatibility, but with `--3way` it does not detect every merge conflict: the real apply can
   still exit nonzero, leave conflict markers, and create unmerged index entries on paths that were
   clean before it. A successful `--3way` apply stages the delta because it implies `--index`;
   nothing is committed or pushed. On failure at either step, report git's exact output and
   `git -C "<mainRoot>" diff --name-only --diff-filter=U`, identify real-apply conflict paths as
   having been clean before the apply, keep the patch and worktree, and hand resolution to the
   user. Explain that those paths can be returned to their pre-apply `HEAD` state with a
   user-chosen `git reset -- <paths>` followed by `git checkout -- <paths>`; do not run that
   recovery automatically.

   Lifecycle follows the hand-back choice. An empty patch skips the main-tree rerun (nothing was
   applied) and counts as applied-and-green for this decision. Applied (or empty) with a green
   authoritative main-tree rerun: run `implement-state --complete`, and add
   `plan-state --mark-implemented` only when this terminal exit is the accepted full phase — an
   `--implement-only`, safeguard, or max-rounds exit never marks the plan. Applied with a red
   rerun: `implement-state --complete` with the
   failing-gate summary and a not-verified note, no `--mark-implemented`, and the staged delta
   left in place with named follow-ups. Discarded: `implement-state --complete` recording the
   delta as discarded, never marked implemented. Leave-for-me: keep the record in-progress — the
   only resumable terminal choice.

10. **Cleanup.** Only after the user confirms the patch landed (or the patch was empty), run
    `git -C "<mainRoot>" worktree remove --force "<worktreePath>"`. In every other case print
    `<worktreePath>`, `<patchFile>`, and that exact removal command, and say the worktree was
    intentionally left in place.

## Implementation routing

### Codex implementer

When `storedPlanReviewThreadId` is non-null, `--fresh` was not passed, and the effective
implementer is the stored plan-review model, resume it. Otherwise start a fresh write thread — a
different model never resumes another model's review thread, because the resumed prompt tells the
implementer it reviewed the plan itself. Embed the complete stored plan verbatim in every fresh
prompt.

Approved, resumed. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier
in this thread.

[full stored plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. Report any impossible step explicitly.
</completeness_contract>
<verification_loop>
[When not isolated: Build the repository and run the unit tests and static checks that exercise
your changes; fix the failures your changes introduced before reporting, and report a failure you
cannot attribute to your edits under Verification as suspected pre-existing instead of fixing it.
Iterate with targeted tests and finish with one full
unit pass when your runtime can execute it truthfully; skip anything needing subprocess, socket,
network, or environment access your runtime lacks and say so. The orchestrator's staged gates are
authoritative for anything you could not run; report exactly what ran, its results, and what
could not run, and never report unverified work as verified.]
[When isolated: Build the repository and run the unit tests and static checks that exercise your
changes inside the worktree named in this task — target it explicitly with --prefix, directory
flags, or cd in the same command; fix the failures your changes introduced before reporting, and
report a failure you cannot attribute to your edits under Verification as suspected pre-existing
instead of fixing it. The worktree is a fresh
checkout, so dependencies may be absent; if a check cannot run, say so explicitly and never
report unverified work as verified. The orchestrator's staged gates remain authoritative.]
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification results, and deviations with reasons.
</compact_output_contract>
```

Include the advisory findings block only when `storedPlanFindings` is non-empty; it never
authorizes work outside the approved plan.

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <storedPlanReviewThreadId> --model <effectiveModel> <effortArg> <isolationArgs> --prompt-file "<payloadFile>"
```

Approved, fresh. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside
this Codex thread<, by reviewedBy when present>.

[full stored plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. Report any impossible step explicitly.
</completeness_contract>
<verification_loop>
[When not isolated: Build the repository and run the unit tests and static checks that exercise
your changes; fix the failures your changes introduced before reporting, and report a failure you
cannot attribute to your edits under Verification as suspected pre-existing instead of fixing it.
Iterate with targeted tests and finish with one full
unit pass when your runtime can execute it truthfully; skip anything needing subprocess, socket,
network, or environment access your runtime lacks and say so. The orchestrator's staged gates are
authoritative for anything you could not run; report exactly what ran, its results, and what
could not run, and never report unverified work as verified.]
[When isolated: Build the repository and run the unit tests and static checks that exercise your
changes inside the worktree named in this task — target it explicitly with --prefix, directory
flags, or cd in the same command; fix the failures your changes introduced before reporting, and
report a failure you cannot attribute to your edits under Verification as suspected pre-existing
instead of fixing it. The worktree is a fresh
checkout, so dependencies may be absent; if a check cannot run, say so explicitly and never
report unverified work as verified. The orchestrator's staged gates remain authoritative.]
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification results, and deviations with reasons.
</compact_output_contract>
```

Include the advisory findings block only when `storedPlanFindings` is non-empty; it never
authorizes work outside the approved plan.

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> <isolationArgs> --prompt-file "<payloadFile>"
```

Unapproved, resumed (only after the preflight gate):

```text
<task>
Implement the reviewed but unapproved plan below in this repository. You reviewed this plan
earlier in this thread, and the user explicitly chose to continue despite its stored verdict.
Implement only the plan's scope and do not silently discard the known findings.

[full stored plan, verbatim]

Latest stored review findings:
[stored findings, verbatim]

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
</task>
```

Use this task block in the approved-resumed command and retain all four safety/output contracts.
Include the findings block only when the stored findings array is non-empty.

Unapproved, fresh (only after the preflight gate):

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was reviewed
outside this Codex thread<, by reviewedBy when present>, and the user explicitly chose to
continue despite its stored verdict.
Implement only the plan's scope and do not silently discard the known findings.

[full stored plan, verbatim]

Latest stored review findings:
[stored findings, verbatim]

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
</task>
```

Use this task block in the approved-fresh command and retain all four safety/output contracts.
Include the findings block only when the stored findings array is non-empty. `--fresh` always
selects the corresponding fresh variant, even when a stored review thread exists.

When `baselineGateSnapshot` recorded any red gate, also append inside every variant's task
block, filled per red gate and shared verbatim with `/stereo:quick`:
`Known pre-existing baseline failures (not yours to fix; leave them and report them under Verification): [gate command, exit status, output tail]`.

Immediately after every implementation or retry background launch, update the implementation
record with that launch's `jobId`. After fetching the result and saving
`implementationThreadId`, update the record with the thread id as well. Apply the same `jobId`
replacement to every later fix launch, so resume checks the worker most recently responsible for
the delta.

Poll and fetch through the routing skill. If resume fails, or Codex claims changes while both
`touchedFiles` and the actual delta are empty, retry once fresh with the identical full prompt.
Retain `<isolationArgs>` on that retry. Save only the latest implementation/fix payload's thread id
as `implementationThreadId`. Record each implementation or retry invocation's per-job usage from
`storedJob.tokenUsage.job`.

### Claude implementer

Use the routing skill's foreground `stereo:implementer` template with the full plan, baseline-dirty
paths, the known-pre-existing-baseline-failures block when the snapshot recorded any red gate
(same wording as the Codex variant), and user-owned command steps. In isolated mode, the prompt also names `<worktreePath>`, its
`baselineCommit`, and its provisioning status, and requires worktree-targeted command forms
(`npm --prefix "<worktreePath>" ...`, directory flags, or `cd` within the same command) for every
build and test run. On an unapproved run with stored findings, also append this
block to the implementer prompt:

```text
Latest stored review findings:
[stored findings, verbatim]
```

On an approved run with stored findings, append this advisory block instead:

```text
Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]
```

After every Claude implementation or fix:

- Record the Agent result's token usage and duration, or `usage unavailable` when omitted.
- Compare `git rev-parse HEAD` with `baselineCommit`.
- If HEAD moved, stop, surface the commit change, and retract the final never-commit claim.
- Inspect `git diff <baselineCommit>`, status, and every new file while excluding baseline-dirty
  paths from attribution.

## Host verification and implement-only stop

Verification is staged. The fast stage is build, unit tests, and static checks — for this
repository:

```text
npm test
npm run typecheck
npm run lint
npm run format:check
npm run check-version
```

Elsewhere, use documented equivalents. Independent gates may run concurrently where the host
affords it. The heavy stage is the repository's documented environment verification — integration
suites, end-to-end runs, real executions (this repository declares none) — and runs strictly
after an accepted implementation review, never before it and never concurrently with it: the
review filters the expensive stage. Neither stage re-runs what the other already proved; the
heavy stage never re-runs unit tests. Record every command and exit result. These are
orchestrator-owned gates, not model-requested shell work.

Pre-review verification is route-dependent, because authority follows the environment:

- After a Claude-routed implementer turn, its shell ran on this host, so its per-command reported
  results are trusted as `host-run implementer verification`. Re-run only the cheap static checks
  plus any gate its report marks not-run; never re-run unit tests its report shows green with
  exit statuses.
- After a Codex-routed implementer turn, in-sandbox results are `sandbox verification (advisory)`
  — sandbox greens have shipped host reds — so run the complete fast stage.

Label orchestrator-run results `authoritative host gates` (`provisional worktree checks` when
they ran in an isolated worktree) and never merge implementer-reported checks into them.

Classify every red fast-stage gate against `baselineGateSnapshot` before acting on it, using the
gate-fix pre-loop below.

For `--implement-only`, run the route-dependent verification and the classification, then stop
without dispatching any fix turn. Report the attributed delta, selected implementer, verification
results itemized under their labels, red-gate classifications, deviations, user-owned steps, and
every implementer invocation's per-invocation usage/duration (or
`usage unavailable`). Point to `/stereo:implement --review-only` and stop without any review or
fix round.

## Gate-fix pre-loop

With a shell-capable implementer most turns arrive green; this pre-loop is the fallback for what
escapes the inner loop, and it covers fast-stage gates only.

Classify each red fast-stage gate against `baselineGateSnapshot`, at gate level:

- Snapshotted green, now red: newly introduced by the delta — direct-fixable here.
- Snapshotted red: pre-existing. Never fix it, and never let any fix turn edit the listed
  baseline-dirty paths; carry both output tails (baseline and current) as reviewer context.
- Never snapshotted — the unit suite over a clean baseline, any gate missing from a legacy
  record, and every heavy-stage red: unattributable. Never direct-fix it; send it to a reviewer
  round for diagnosis with the current output tail, and dispatch fix turns only for failures the
  reviewer confirms as delta-caused.

Budgets for newly-introduced reds: mechanical failures (formatting, lint, type errors, version
sync) get at most 2 direct fix turns; behavioral failures (failing test assertions) get exactly
1; a mixed episode caps at 2 turns total. Verification between and after turns stays
route-dependent — the trust rule is not suspended inside the pre-loop. After each direct turn,
check only the previously red gates: trust a Claude-routed turn's report showing them green with
exit statuses (re-running just the static ones among them plus anything reported not-run), and
re-run them after a Codex-routed turn. Once they are clear, finish with the route-dependent
pre-review verification — the complete fast stage after a Codex-routed turn, the static checks
plus not-run items after a Claude-routed one — before any review round. If reds
persist at the episode cap, ask the gate-specific question: one more direct turn, reviewer
diagnosis now, or stop and report. The cap blocks only fix turns — a green delta always proceeds
to review.

A direct fix turn reuses the implementation fix launch unchanged. For a Codex-routed implementer,
write the same fix payload with its task block swapped for this shared gate-fix task block, then
use the existing Codex fix launch with the same thread, model, effort, and `<isolationArgs>`:

```text
<task>
Fix the newly-introduced gate failures below in this repository. Each entry names the gate
command, its exit status, and its output tail. Change only what fixing them requires, keep all
other behavior unchanged, and never edit the listed baseline-dirty paths.

[attributed failing gates with command, exit status, and output tail]

Baseline-dirty paths (never edit):
[baseline-dirty paths, or `none`]

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
</task>
```

For a Claude-routed implementer, apply the routing skill's implementer continuation rule:
continue the same implementation agent with only the attributed failures as numbered findings;
re-invoke it fresh with the recorded model and the routing skill's complete brief only when
continuation is unsupported or fails, and report which happened.

Account for every fix turn durably. Before dispatching any fix turn — direct or review-driven —
increment `fixTurns` and append a pending `gateFixEpisodes` entry with `implement-state --update`,
folding in any adjacent round entry so one write covers both;
replace the pending entry with the outcome once the turn completes. Every episode-touching update
carries the
complete episodes array, and a Claude-routed turn updates the record even though it has no
`jobId`. Escalation briefs to the reviewer carry the full episode history and the pre-existing
context tails.

Legacy records degrade safely: a record without `baselineGateSnapshot` makes every red
unattributable (reviewer diagnosis, no direct fixes), and a record without `fixTurns` counts from
zero plus session-observed turns. Report the degradation in both cases.

## Full implementation-review and fix loop

The loop is entered through the gate-fix pre-loop: the reviewer receives a verified delta, an
explicitly labeled escalation, or an unattributable-red diagnosis request — never raw compiler
output the pre-loop could have attributed first.

Build review input from the full plan, `baselineCommit`, baseline-dirty paths, current status/diff,
changed and untracked files, implementer report, host results, and `storedPlanFindings`. The
canonical contract is `${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json`.

Maintain `implementationReviewHistory` for every route and, for a named-Claude reviewer, the
continuation handle for this command run only. Build the history every round even while a reviewer
is being continued, because a fallback round needs it:

- Round 1 contains the implementer report verbatim, states that no earlier implementation-review
  fixes exist, and contains `storedPlanFindings` verbatim when non-empty. Label them as "Advisory
  findings from the approving plan review, context only: the approved plan takes precedence, and
  the reviewer must not report a fix solely because an advisory finding was not adopted" when the
  stored verdict is `approve` and as known unapproved findings otherwise; explicitly state that
  there are no stored plan-review findings when the array is empty.
- Every later round preserves the round-1 context, retains every prior numbered fix, marks each
  `resolved` or `unresolved` from the latest attributed delta and host results, and includes the
  latest fix-round implementer report verbatim.

The same per-round delta those bullets describe—the newly judged fixes, latest fix-round
implementer report, and latest host results—is what a continued round sends as its compact
message.

Route every round:

- For `claude:session`, named-Claude round 1, every named-Claude stateless fallback round, and
  every Codex round, read `${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md` and fill it once
  for the current round without changing any other text:
  - `{{PLAN_INPUT}}` = the full stored plan.
  - `{{BASELINE_CONTEXT}}` = the normal phase-flow attribution semantics, including
    `baselineCommit`, baseline-dirty paths excluded from attribution, current status/diff, and all
    attributed changed and untracked files.
  - `{{REVIEW_CONTEXT}}` = the current `implementationReviewHistory`.
  - `{{HOST_RESULTS}}` = every named verification command and its exact exit result/output
    summary for the latest delta, grouped under its route-specific label — `authoritative host
gates`, `host-run implementer verification`, `sandbox verification (advisory)`, or
    `provisional worktree checks` — plus the red-gate classifications, episode history, and
    pre-existing baseline tails when any exist. The implementer-reported group may cite the
    verbatim report's `Verification` section in `{{REVIEW_CONTEXT}}` instead of restating its
    lines. Implementer-reported checks never merge into
    orchestrator results.
    Use the resulting `implementationReviewBrief` verbatim for the selected route.
- `claude:session`: apply `implementationReviewBrief` inline and produce internal
  `{acceptable, summary, fixes}` data.
- Named Claude round 1: use `implementationReviewBrief` as the routing skill's
  `stereo:implementation-reviewer` prompt and retain its continuation handle for this command
  only.
- Later named-Claude rounds: apply the routing skill's
  "Continuing an agent across review rounds" rule. Continue the same reviewer with the round
  number, the previous round's numbered fixes and their to-be-judged `resolved`/`unresolved`
  status, the latest fix-round implementer report verbatim, the latest host results, and the
  instruction to re-inspect the current worktree and verify its own earlier findings when
  supported; otherwise use the fully briefed stateless fallback above. Apply the same schema
  validation in either mode and report whether the round was continued or re-briefed.
- Codex: write `implementationReviewBrief` verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, start a fresh read-only task, and save its id only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" <isolationArgs> --prompt-file "<payloadFile>"
```

Parse named-Claude output directly and Codex output from `storedJob.result.rawOutput`. Apply the
routing skill's validation and retry, including its continuation ladder for later named-Claude
rounds. A Codex retry resumes only
`implementationReviewThreadId` and preserves the same `--output-schema` flag and
`<isolationArgs>`; never assign it to `implementationThreadId`. After the routing skill's retries
for that round are exhausted, ask whether to review inline or stop.

After every completed review round, report its number, verdict/fix count, and reviewer
per-invocation usage and duration (or `usage unavailable`), and whether the round was continued or
re-briefed. Update the implementation record after every review with `round` equal to the number of
completed review rounds, the numbered fixes and their latest judgments, `latestVerdict`, and
bounded implementer-report and host-result summaries. If acceptable, carry that final round entry
in the `--complete` payload instead of a separate update, and finish. Otherwise fold the round
entry, the incremented `fixTurns`, and the pending episode entry into one pre-dispatch update —
one write, still before the launch, so the crash semantics are unchanged — then send the
exact numbered fixes to the same implementer kind that produced the delta.

Codex fix. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Fix the review findings below in this repository. Keep all other behavior unchanged.

[numbered fixes with file, line, problem, and correct result]
</task>
<verification_loop>
[When not isolated: Build the repository and run the unit tests and static checks that exercise
your changes; fix the failures your changes introduced before reporting, and report a failure you
cannot attribute to your edits under Verification as suspected pre-existing instead of fixing it.
Iterate with targeted tests and finish with one full
unit pass when your runtime can execute it truthfully; skip anything needing subprocess, socket,
network, or environment access your runtime lacks and say so. The orchestrator's staged gates are
authoritative for anything you could not run; report exactly what ran, its results, and what
could not run, and never report unverified work as verified.]
[When isolated: Build the repository and run the unit tests and static checks that exercise your
changes inside the worktree named in this task — target it explicitly with --prefix, directory
flags, or cd in the same command; fix the failures your changes introduced before reporting, and
report a failure you cannot attribute to your edits under Verification as suspected pre-existing
instead of fixing it. The worktree is a fresh
checkout, so dependencies may be absent; if a check cannot run, say so explicitly and never
report unverified work as verified. The orchestrator's staged gates remain authoritative.]
</verification_loop>
<compact_output_contract>
Report which findings were fixed, how, and what verification ran.
</compact_output_contract>
```

The four implementer contract bodies and the gate-fix task block are shared verbatim across
`/stereo:implement` and `/stereo:quick` and must be edited together.

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> <isolationArgs> --prompt-file "<payloadFile>"
```

For Claude fixes, apply the routing skill's implementer continuation rule: continue the same
implementation agent with only the numbered fixes; re-invoke it fresh with the original model
and the routing skill's complete brief only when continuation is unsupported or fails, and
report which happened. Recheck HEAD and the delta immediately. A review-driven fix turn increments
`fixTurns` with the same pre-dispatch sequencing as the pre-loop. After every fix, route the delta
back through the route-dependent pre-review verification, then re-run the
selected reviewer. Update every prior fix's `resolved`/`unresolved` status before constructing the
next round's `{{REVIEW_CONTEXT}}`. After the fix launch/result and fresh verification, update the
durable round entry with bounded reports and judgments without incrementing `round`; that field
counts completed review rounds, so a crash after fixes resumes by re-reviewing the actual delta.

When `fixTurns` reaches `--max-fix-rounds` (default 4), or when substantially the same issue
survives three rounds,
show remaining fixes and ask whether to send one more implementer round, let the orchestrator fix
directly, or stop and report as-is.

After the full phase receives an `acceptable` implementation review, run the repository's
documented heavy stage — strictly after acceptance, before the lifecycle markers, with no unit
re-run inside it; where the repository declares none (as here), the stage is a no-op. A heavy red
is unattributable by construction: a further reviewer round — continued where the route supports
it, fresh otherwise — diagnoses it first. A
reviewer-confirmed delta-caused failure re-enters the fix chain — fix turn, route-dependent
pre-review verification, further review round, heavy stage again — with each fix turn counting
toward the cap. A pre-existing or undiagnosable heavy red takes not-verified semantics: report
it, complete the record with the failing-gate summary, and skip `plan-state --mark-implemented`.

After the accepted review and a green (or absent) heavy stage, and before the final report,
run both lifecycle writes immediately (in isolated mode, defer them to the hand-back lifecycle in
**Isolated worktree mode** instead):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented --json <slotArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" implement-state --complete --state-file "<statePayloadFile>" --json
```

The completion payload contains the accepted final review summary, final round, and latest host
summary. Report a failure to set either marker but never fail the implementation run because of
it.
`--implement-only` and `--review-only` stop before a full accepted phase completes and never mark
the plan implemented.

## Resuming an interrupted phase

For `--resume`, do not create a new baseline or launch an implementer before completing these
checks:

1. Run `implement-state --json`. If `available` is false, stop and direct the user to run
   `/stereo:implement` without `--resume`. If `unreadable` is true, report its `path` and
   `parseError`, then stop. If the record status is `complete`, report its round, verdict, and
   `completedAt`, then ask exactly once whether to start a fresh phase, clear the record and stop,
   or stop without changing it.
2. Read `isolated` and `worktree.path` from the record. For an isolated record, announce that the
   bare resume will use the recorded worktree. Require a non-empty absolute path, verify the path
   is still a directory, and verify the exact path appears in
   `git -C "<mainRoot>" worktree list --porcelain`. When either check fails, report the recorded
   path, explain that the isolated delta is no longer recoverable from the record, and offer
   `implement-state --clear` followed by a fresh `/stereo:implement --isolated`; do not launch a
   worker. When it is present, reuse it as `<worktreePath>` for `<isolationArgs>`, every diff and
   gate, and patch hand-back. For a non-isolated record, reject an explicit `--isolated --resume`
   and tell the user to run without `--resume` to start an isolated phase.
3. Take the recorded slot from the `implement-state --json` payload's top-level `plan.slot`,
   announce it, and set `<slotArg>` from it. Run `plan-state --json --slot <recorded slot>`. If
   unavailable, stop. When the implementation-state payload's `planMatches` is false, show both
   recorded and current plan fingerprints and timestamps, warn that `{{PLAN_INPUT}}` will use the
   current stored plan, and ask exactly once whether to continue against that current plan or stop.
4. Check the recorded worker before inspecting a possibly partial delta. Also list this
   workspace's jobs via `/stereo:status` and check for a live write job newer than the recorded
   `jobId` — a crash inside the dispatch window leaves the record pointing one launch behind, and
   an orphan worker may still be mutating the tree; treat such a job as the active worker (same
   wait-or-stop question) and close the pending episode from its outcome. When `jobId` exists, run
   `status <jobId> --json` first:
   - For `queued` or `running`, report its phase and elapsed time and ask exactly once whether to
     wait or stop and leave it running. Waiting uses the routing skill's bounded
     `status <jobId> --wait --timeout-ms 90000` windows; once terminal, fetch its result and
     continue.
   - For `completed`, run `result <jobId> --report --json` and use the payload's `report` field as
     the latest implementer or fix-turn report in `{{REVIEW_CONTEXT}}` — label which it is from
     the record's round and episode state; the job most recently responsible for the delta may be
     a fix launch, never assume it is round 1.
   - For `failed`, `cancelled`, or an unknown id, report the condition and continue with the
     recorded state.
5. Compare `git rev-parse HEAD` with recorded `baselineCommit` for a non-isolated record. For an
   isolated record, make that comparison with
   `git -C "<worktreePath>" rev-parse HEAD`. When equal, resume normally. When HEAD moved, verify
   the baseline with `git cat-file -e <baselineCommit>^{commit}` against the same target and inspect
   its delta; if it resolves and a delta exists, report the move, retain that baseline for
   attribution, and ask exactly once whether to continue or stop. If it no longer resolves, stop as
   stale, explain why attribution is impossible, and offer `implement-state --clear`. When HEAD
   equals the baseline but no attributed delta exists beyond the recorded baseline-dirty paths,
   report that the work is gone and ask whether to clear and restart or stop.
6. Re-inspect the actual status, diff, every changed/untracked file, and baseline-dirty exclusions.
   Rerun the complete fast stage. Recorded host results are historical summaries,
   never current evidence. Classify every red against the recorded `baselineGateSnapshot` and feed
   the gate-fix pre-loop; a record without a snapshot makes every red unattributable — reviewer
   diagnosis, never a direct fix — and says so.
7. An isolated record whose `latestVerdict` is acceptable is an accepted phase awaiting
   hand-back, not an unfinished review loop: skip review re-entry, re-verify the worktree (the
   containment guard plus the step-6 gates), and resume directly at the hand-back question with
   the step-9 lifecycle. Otherwise
   re-enter at review round `record.round + 1`; `record.round` counts completed review rounds.
   Round 0 therefore resumes at round 1, and a crash after fixes but before review correctly
   re-reviews the actual delta. Use the fetched report from step 4 when available; otherwise label
   the implementer report as unavailable or as a stored pre-resume summary.
8. The first resumed reviewer round is always the stateless re-brief path. Rebuild
   `{{REVIEW_CONTEXT}}` from `record.rounds`: retain round-1 context, every prior numbered fix and
   latest `resolved`/`unresolved` judgment, and label stored reports as pre-resume summaries. State
   that a fresh session has no continuation handle. A named-Claude reviewer may keep the new handle
   for later rounds in this resumed command run.
9. For Codex fixes, resume recorded `implementationThreadId` with the recorded implementer model
   and effort. If the id is null, pruned, or resume fails, use the existing retry-fresh rule and
   embed the complete current plan plus every numbered fix in the new write thread. For a
   Claude-routed implementer, re-invoke the contained implementer with the recorded model, full
   plan, and numbered fixes.
10. `--max-fix-rounds` counts recorded work too: resume the cap from recorded `fixTurns` plus
    session-observed turns, and rebuild episode context from `gateFixEpisodes` labeled as
    pre-resume history. Close any still-pending episode entry: use the step-4 fetched job outcome
    when it exists, otherwise mark the entry `interrupted` — never carry a pending entry forward
    in the resumed record. A legacy record without the counter counts from zero plus
    session-observed turns and says so. An explicit flag overrides recorded
    `maxFixRounds`; otherwise retain the recorded cap. If the record already reached the effective
    cap, ask the existing safeguard question before starting another review or fix round.

After these checks, use the normal full review/fix loop and state updates. Resume never reuses
recorded host results as proof and never assumes conversation history survived.

## Final report

Name the implemented plan slot. Report selected roles, every fix turn (direct gate-fix and
review-driven, with the gates or findings that drove it), attributed files, verification results
itemized by stage under their route-specific labels, every pre-existing or unattributable red and
its disposition,
deviations, user-owned steps, all stored open questions and residual risks, and
per-invocation usage/duration for every
implementer, fix, and reviewer turn. Never present an implementer-reported check as an
orchestrator gate result. Use `usage unavailable` when metrics were omitted. For Codex
turns use `storedJob.tokenUsage.job`; for named Claude turns use the Agent result's usage and
duration. For Codex implementation, include `implementationThreadId` and
`codex resume <implementationThreadId>`. Label `storedJob.tokenUsage.thread` cumulative when shown
and never compare it with one Claude invocation. Label `storedPlanReviewThreadId` and
`implementationReviewThreadId` by role and never present them as implementation resume targets.

Report the durable implementation record and its final lifecycle: a fully accepted phase marks it
complete, while an interrupted phase remains available through `/stereo:implement --resume`. When
a completed record is explicitly cleared to start over, say so. For `--review-only --base`, repeat
that the committed range was reviewed in full and list uncommitted dirty/untracked paths as out of
scope, including every range/dirty overlap warning.

For an isolated run, also report the worktree path, its provisioning path (symlink, documented
install, or unprovisioned), patch file, hand-back decision and result,
including `staged, not committed` on success and every conflicted path on failure. Say whether the
worktree was removed and give each worktree gate's provenance — native, main toolchain, or
`not runnable in the isolated worktree` — plus
the result of its authoritative post-hand-back main-tree rerun.

Give rollback guidance relative to `baselineCommit` without erasing baseline-dirty paths. If HEAD
is unchanged, state that nothing was committed or pushed. If it moved, retract that statement and
report the observed change. Never commit or push.
