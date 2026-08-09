---
description: Race Claude and Codex implementers on an approved plan; hand back the winning delta
argument-hint: '[--implementer <model>]... [--implementer-effort <none|minimal|low|medium|high|xhigh|max>]... [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--resume] [--slot <name>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(npm:*), Bash(git:*), Bash(npx:*), Bash(pnpm:*), Bash(yarn:*), Bash(dotnet:*), Bash(cargo:*), Bash(go:*), Bash(make:*), Bash(python3:*), Bash(pytest:*), Bash(mvn:*), Bash(gradle:*), AskUserQuestion, Agent
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
  model. Zero occurrences select the conditional default lineup below. With one, stop, explain that a
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
  Reject the flag entirely when `--implementer` is absent, name the effective default lineup, and
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
- `--resume` re-enters the recorded incomplete tournament after a crashed, compacted, or closed
  Claude session. The record owns the lineup, reviewer, every effort, and plan slot. Reject
  `--implementer`, `--implementer-effort`, `--implementation-reviewer`,
  `--implementation-reviewer-effort`, `--effort`, and `--slot` with `--resume`; name the recorded
  values and tell the user to run without `--resume` to start over. Reviewer flags remain legal on
  `/stereo:implement --resume`, but are rejected here because every contestant must face the same
  recorded reviewer or the comparison is meaningless.

When `--implementer` is absent entirely, use the conditional default lineup. Set `c1` to the
workspace `implementer` model when its `config --json` entry has a null `invalidReason` and resolves
to a Codex route; otherwise use the fallback `c1` = `codex:sol`. Set `c2` = `claude:opus` always.
Report which default source supplied `c1` before launch.

The Codex effort ladder below gives `c1` the effective model's model-pair default unless `--effort`
or the valid workspace implementer effort default overrides it. The built-in `codex:sol` fallback's
model-pair default is `max`.

Claude contestants have no effort dial: model selection is the per-invocation Claude strength
control, and Stereo's agent definitions omit `effort`, so a Claude contestant runs at the session's
configured effort. Report its effort as `not applicable` and never state that an effort was applied.
For `claude:inherit`, report the effective model returned by the Agent result, or `unavailable`.

Reject missing values, duplicate single-occurrence flags, invalid efforts, positionals, unknown
flags, unknown `claude:*` values, and `codex:claude:*` before repository work. For Codex contestants
only, resolve effective effort as paired `--implementer-effort`, then command-wide `--effort`, then
the valid applicable workspace implementer effort, then the routing skill's model-pair default. An
effort stored alongside a Claude-routed implementer is not applicable to the Codex fallback. A Claude
contestant takes no effort argument; any stored workspace implementer effort is inert for it.
Resolve a Codex reviewer's effort as `--implementation-reviewer-effort`, then command-wide
`--effort`, then the valid workspace implementation-reviewer effort, then the model-pair default.
Omit a null effort argument.

Reject these `/stereo:implement` mode flags here:

- Reject `--isolated` and explain that tournament isolation is unconditional.
- Reject `--implement-only`, `--review-only`, `--base`, `--max-fix-rounds`, and `--fresh`, naming
  `/stereo:implement` as their supported home.
- Explain that `--fresh` is unnecessary: contestants always start fresh write threads and never
  resume a stored plan-review thread. Sharing that thread would couple contestants that must stay
  independent.

## Workspace role defaults

Before the stored-plan preflight, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --json
```

Apply the routing skill's "Workspace role defaults" mechanics to the result.

The workspace `implementer` model supplies `c1` only in the default lineup. Explicit
`--implementer` flags always win, and no workspace model default is injected into an explicit
lineup. A valid Claude-routed workspace implementer is inert for the lineup: report its selection
and route by name and use the built-in `codex:sol` fallback. A stored `claude:*` selection never
reaches the companion's `--model` flag. Report and ignore an invalid entry under the existing
`invalidReason` rule. A valid standalone or Codex-routed workspace implementer effort still
participates in the Codex effort ladder and is inert for Claude. An effort stored alongside a
Claude-routed implementer is itself inert: report both inert values, and pass neither as the
companion's `--model` nor `--effort`. The workspace `implementationReviewer` entry participates
normally in reviewer model and effort resolution.

Before launching anything, announce the lineup source as `explicit`,
`default (workspace implementer default)`, or `default (built-in)`. Name the workspace selection
when it supplied `c1` or was inert. State each contestant's label, route, selection, and effective
effort (`not applicable` for Claude), plus the reviewer's final effective model and effort. State
each Claude contestant's conduct — file edits plus a build/test-scoped shell targeted at its own
worktree, with unprovisioned worktrees reporting checks as not run — name any plan steps outside
that scope that will appear as deviations, and say that multiple Claude contestants run
sequentially.

## Preflight

For `--resume`, use **Resuming an interrupted tournament** instead of this fresh preflight.

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
   writes, updates, completes, or clears this record. It keeps its own separate record described in
   **Tournament state record**.

4. Set `<mainRoot>` from `git rev-parse --show-toplevel`, `baselineCommit` from
   `git rev-parse HEAD`, and `baselineDirty` from the exact path set in
   `git status --porcelain=v1 --untracked-files=all`. If dirty, explain that every contestant starts
   from `HEAD` and lacks those changes, and that hand-back refuses to patch paths overlapping the
   currently dirty set. Ask exactly once whether to stop and commit or stash first (recommended) or
   continue. If the stop-time review gate is enabled, mention that it reviews the main tree, which
   remains clean during the run, and point to `/stereo:setup --disable-review-gate`.
   Store that exact set in the record as `baselineDirtyPaths`.
5. State explicitly before launch that the tournament writes a durable tournament record and, after
   a fully successful hand-back, marks the plan implemented. It never writes `implement-state`,
   never commits, and never pushes.

## Tournament state record

Use the Write tool under the routing skill's temporary-directory rule to create
`<statePayloadFile>`. Never deliver record JSON through the shell. Use these state actions; the
optional `<slotArg>` appears only on the fresh record action:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --record --state-file "<statePayloadFile>" --json <slotArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --update --state-file "<statePayloadFile>" --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --complete --state-file "<statePayloadFile>" --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" tournament-state --clear --json
```

Read the record with flagless `tournament-state --json`.

The record contains `version`, `status`, `baselineCommit`, `baselineDirtyPaths`, `mainRoot`,
`lineupSource` (`default` or `explicit`), and `reviewer` with `selection`, `route`, `model`, and
`effort`. Its `contestants[]` entries contain `label`, `route`, `selection`, `model`, `effort`,
`source` (`flag`, `workspace-default`, or `built-in`), `worktreePath`, `jobId`, `threadId`, `status`
(`pending`, `running`, `completed`, `withdrawn`, or `empty`), `patchFile`, a `review` containing
`acceptable`, `fixCount`, and a bounded `summary`, and a bounded `note`. It may also contain `winner`
with `label` and `rule`, and `handBack` with `decision`, `applied`, `conflictPaths`, `gates[]`, and
`markedImplemented`. The companion adds the `plan` snapshot and the creation, update, completion,
and other relevant timestamps.

Store bounded summaries, never verbatim implementer or review reports. The companion rejects a
`--state-file` over 512 KiB instead of truncating it. An update merges `contestants[]` by `label` and
replaces the recorded entry, so always send the complete entry; resending an entry is idempotent. A
fresh record replaces any older tournament record. Every state-write failure is reported but never
fails the tournament.

There is one tournament record per workspace, so concurrent tournaments are last-write-wins.
Clearing a stored plan does not cascade into this record: it may point to several worktrees and patch
files, and the resume flow handles a missing plan explicitly. Use the clear action only as an
explicit reset; it removes the record but reports retained worktree paths and their removal commands.

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

Provision each worktree the same symlink-first way as `/stereo:implement`'s isolated mode
(orchestrator-executed `node -e "fs.symlinkSync(process.argv[1], process.argv[2], 'junction')"`
from the main checkout's `node_modules` for npm-family repositories). A documented install is
per-contestant cost: run one only when the plan builds or tests artifacts and symlinking is
impossible; otherwise the worktree stays unprovisioned. Record each contestant's provisioning
status in its state entry (`provisioning`: `symlink`, `install`, or `unprovisioned`) and state it
in that contestant's prompt; on resume, a legacy entry without the field re-derives it by testing
for `<worktreePath>/node_modules`.

Immediately after every contestant worktree has been created and before the first launch, use the
record action with every contestant at `status: pending`.

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

Launch Codex contestants strictly in label order. Immediately after each launch, use the tournament
state update action to save its `jobId` and `status: running`, then run exactly one flagless instant
status call, never `--wait` and never a loop, report its phase, and only then launch the next Codex
contestant:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId>
```

The shared workspace broker serializes turns, so the first Codex contestant holds its turn slot and
later Codex contestants deterministically fall back to a private Codex runtime, while interleaved
setup requests can still produce a transient busy rejection.

If a Codex contestant reaches `failed` with an error saying the shared Codex broker is busy,
relaunch it exactly once with the identical payload file, worktree, model, and effort flags; run the
same one instant status call, replace its old job id with the new one, and immediately persist the
complete replacement entry with the tournament state update action. Never retry that condition
again. Any other failed job, a second busy failure, or a cancelled job withdraws the contestant with
its exact status and error.

### Claude contestants

For each Claude contestant, in label order:

1. Immediately before the Agent invocation, use the tournament state update action to set the
   contestant to `status: running`. This pre-invocation write makes a still-`pending` Claude
   contestant provably un-started on resume when the write succeeded and its worktree delta is
   empty. Then invoke the routing skill's foreground template:

   ```text
   subagent_type: "stereo:implementer"
   model: "<sonnet|opus|haiku|fable>"
   run_in_background: false
   prompt: |
     [complete contestant prompt]
   ```

   For `claude:inherit`, omit the `model` parameter entirely.

2. Compose the complete contestant prompt in this order:

   - Begin with this fixed lead:

     ```text
     Implement the plan below in the worktree this prompt names. Your shell exists only to build
     the repository and run its tests and static checks against that worktree; fix failures
     before reporting, and never claim a result from a command you did not run.
     ```

   - Include the same `<task>` block written for the Codex contestants above, verbatim: use the
     approved or unapproved variant, the same advisory or latest-findings inclusion rule, and the
     same `The working root for this task is <worktreePath>...` sentence.
   - Include `<action_safety>` and `<completeness_contract>` verbatim from the shared payload.
   - In place of `<verification_loop>`, include:

     ```text
     <verification_loop>
     Build the repository and run the unit tests and static checks that exercise your changes
     inside the worktree named in this task — target it explicitly with --prefix, directory
     flags, or cd in the same command; fix the failures your changes introduced before reporting,
     and report a failure you cannot attribute to your edits under Verification as suspected
     pre-existing instead of fixing it. The worktree is a fresh
     checkout, so dependencies may be absent; if a check cannot run, say so explicitly and never
     report unverified work as verified. The orchestrator's staged gates remain authoritative.
     </verification_loop>
     ```

   - Include this worktree-paths block, reusing `/stereo:implement`'s isolated-mode containment,
     with the contestant's recorded provisioning status filled in:

     ```text
     <worktree_paths>
     Use absolute paths under <worktreePath> for every Read, Glob, Grep, Edit, and Write
     operation, and target every build or test command at the worktree explicitly. Never read,
     write, or run anything against <mainRoot>. The worktree is a clean checkout at
     <baselineCommit>, so every change in it is this contestant's delta. Provisioning status:
     [provisioned (symlinked or installed dependencies) | unprovisioned — dependencies are
     absent; report each check you cannot run as `- nothing ran` with the reason].
     </worktree_paths>
     ```

   - In place of `<compact_output_contract>`, require a compact plain-text agent report with the
     exact labels `Files touched`, `Plan steps completed`, `Verification`, and `Deviations`.

3. Validate those four labels through the routing skill. Record the Agent result's per-invocation
   usage and duration, or `usage unavailable`. For `claude:inherit`, record the effective model
   reported by the Agent result, or `unavailable`. As soon as the invocation returns, use the
   tournament state update action with the complete contestant entry and `status: completed` or
   `status: withdrawn`, plus a bounded note. Never continue one implementer agent across contestants:
   every contestant is a fresh invocation.

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
result reveals the qualifying busy failure. After each job reaches terminal and its result is
fetched, use the tournament state update action to save its status, `threadId`, and a bounded usage
note.

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
Use one tournament state update action carrying every completed contestant's `patchFile` (and
`status: empty` where the delta is empty): updates merge `contestants[]` by label, so a single
batched write covers the whole evidence pass.

Detect byte-identical patch files and say so in the comparison instead of implying their deltas
differ.

Do not run host gates per contestant: paying the orchestrator's full battery for every candidate
multiplies its cost by the field size to verify deltas that will mostly be discarded, and the one
delta that survives gets the authoritative main-tree run after hand-back. For every contestant
set `{{HOST_RESULTS}}` to: the orchestrator ran no gates in this worktree and the reviewer must
not treat the delta as host-verified, plus the contestant's own reported checks labeled
`contestant-reported checks` with the contestant's route stated beside the label — tournament
never applies the implement/quick orchestrator labels to contestant self-reports. Run the
complete gate set once in the main tree only after a successful
hand-back.

## Per-contestant implementation review

Review every non-empty completed contestant exactly once. With a Codex-routed reviewer, launch
every per-contestant review task in label order — each with its own payload file and a fresh
independent thread, exactly as below — then rotate-poll them to terminal like contestant jobs;
the per-contestant briefs never mention another contestant, so concurrent execution changes
nothing about their independence. With `claude:session` or a named-Claude reviewer, review
strictly sequentially in contestant
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
- `{{HOST_RESULTS}}` = the per-contestant statement defined in **Evidence** (orchestrator gates
  not run; `contestant-reported checks` with the route stated).

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
task. After validating a review, use the tournament state update action to save that contestant's
complete bounded `review`.

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
metric. State beside the table that no candidate has passed the orchestrator's authoritative
main-tree gates: contestant self-reports are `contestant-reported checks` only, never
orchestrator-verified, and plan steps outside a contestant's build/test scope
appear as deviations. Also flag
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
Use the tournament state update action to save the winner's label and rule id, or the discard-all
outcome, before cleanup continues.

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

Use the tournament state update action to save the `handBack` decision and result, including apply
status and conflict paths when present.

Remove the winner's worktree automatically after a successful patch apply on either path, whether
user-confirmed or decisive and automatic. The explicit `Discard the worktree without applying`
choice also authorizes its removal while the patch file remains recoverable. For `Leave`, an overlap
refusal, an apply failure, or any other non-success result, print `<worktreePath>`, `<patchFile>`, and
this exact command, and say the worktree was intentionally left in place:

```bash
git -C "<mainRoot>" worktree remove --force "<worktreePath>"
```

Always print retained withdrawn-contestant worktrees and their exact removal commands. A session
ending mid-tournament leaves a resumable record; recover with `/stereo:tournament --resume`, and
still list every worktree with `git -C "<mainRoot>" worktree list --porcelain` when checking or
cleaning up retained paths.

## Resuming an interrupted tournament

1. Run flagless `tournament-state --json`. If `available: false`, stop and direct the user to a
   fresh `/stereo:tournament` run. If `unreadable: true`, report `path` and `parseError`, then stop. If
   `status: complete`, report the winner, hand-back result, and `completedAt`, then ask exactly once
   whether to start a fresh tournament, clear the record and stop, or stop without changing it.
2. Announce the recorded lineup, reviewer, slot, and baseline verbatim. They are authoritative for
   the resumed tournament.
3. Take the recorded slot from `plan.slot`, define `<slotArg>` from it, and run
   `plan-state --json <slotArg>`. If the selected plan is unavailable, report that the raced plan is
   gone, offer `tournament-state --clear`, and stop. The plan clear action deliberately does not
   cascade into tournament state. When the tournament payload's `planMatches` is false, show both
   fingerprints and both timestamps, warn that `{{PLAN_INPUT}}` would use the current stored plan,
   and ask exactly once whether to continue or stop.
4. Verify that each recorded `worktreePath` is still a directory and still appears in
   `git -C "<mainRoot>" worktree list --porcelain`. A missing worktree withdraws that contestant;
   report its recorded patch path when one exists.
5. Verify the recorded baseline with `git cat-file -e <baselineCommit>^{commit}` and re-run the
   containment guard against the recorded `baselineDirtyPaths`. The unconditional containment stop
   applies unchanged.
6. Re-enter by recorded contestant status, using the existing sections by name and never repeating
   their launch, poll, or review commands. Before starting any `pending` contestant, run
   `git -C "<worktreePath>" add -N .` and then check
   `git -C "<worktreePath>" diff --quiet <baselineCommit>`. State writes are best-effort, so
   `pending` alone does not prove that the contestant never started. A non-empty delta proves that
   something ran. For a Claude contestant, follow the existing no-re-invoke path in **Claude
   contestants**: judge the delta and record `report unavailable or malformed`. For a Codex
   contestant, additionally check `/stereo:status` for a live job targeting that worktree before any
   relaunch, so resume never mixes two runs in one delta; poll a discovered live job, fetch a
   discovered terminal result, or judge an orphan delta without relaunching. Only an empty-delta
   `pending` contestant is a fresh sample: launch pending Codex through **Codex contestants**, and
   invoke pending Claude through **Claude contestants**. Poll a `running` Codex contestant with a
   `jobId` through **Waiting and containment**. A `running` Claude contestant follows the
   no-re-invoke path. Send `completed` without `patchFile` to **Evidence**, patched without a recorded
   `review` to **Per-contestant implementation review**, all reviewed without a `winner` to
   **Selection**, a `winner` without `handBack` to **Hand-back and cleanup**, and an applied hand-back
   without recorded gates to **Post-hand-back verification and final report**.
7. Resume can recover the lineup and reviewer, worktree paths, baseline commit and baseline-dirty
   set, Codex job ids and thread ids, recorded per-contestant status, patch paths, and validated
   review verdicts. Codex jobs are durable and remain visible to `/stereo:status` and
   `/stereo:result`. Resume cannot recover a Claude contestant already `running`, because it is
   session-bound: re-check its worktree delta and record `report unavailable or malformed` under the
   existing no-retry rule instead of re-invoking, since invoking against partial edits is a fix round
   rather than a fresh sample. It also cannot recover an in-flight Claude agent turn or unrecorded
   Claude usage metrics; report `usage unavailable`.
8. Recorded gate results and recorded reports are historical summaries, never current evidence.
9. Never re-review a contestant that already has a recorded validated verdict.

## Post-hand-back verification and final report

After any successful apply, whether user-confirmed or decisive and automatic, run the repository's
identifiable host gates once in the main tree — the `authoritative host gates` for the applied
delta, regardless of what any contestant reported. For this repository run and record every
command's
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

After the gates, use the tournament state update action to record every gate command and result.
When all of the following hold, mark the plan implemented without asking:

1. The winner's validated review has `acceptable: true`, whether it was auto-selected or selected
   by the user.
2. The patch apply succeeded, whether automatic or user-confirmed.
3. At least one main-tree host gate was identifiable and every gate that ran exited zero.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented --json <slotArg>
```

Report a marker failure but never fail the run. When no host gate is identifiable in the repository,
do not mark the plan and say so in the report. Record the marker outcome in
`handBack.markedImplemented`: use the returned `implementedAt` timestamp on success and `null` when
the marker failed or was skipped, with a bounded failure or skip note. Then use the tournament state
complete action as the last state write. For any other terminal hand-back or discard outcome,
complete the record without a marker after recording the outcome. `implement-state` is still never
written, because it describes a resumable implementation phase that the tournament does not run;
`implementedAt` describes the plan's lifecycle, which a successful tournament hand-back does
complete.

The final report includes:

- whether the lineup was default or explicit, the source that supplied `c1`, the plan slot, and every
  contestant's label, route, model, effort, job id, thread id, status, and review verdict; use
  `not applicable` for a Claude contestant's effort, job id, and thread id
- which of `single-acceptable`, `identical-acceptable`, `tie-ask`, or `none-acceptable-ask` fired;
  whether that rule selected the winner automatically or caused the user to be asked and why the
  evidence was ambiguous; the winner and its evidence; and every alternative with its verdict,
  including identical-delta notes and reported deviations
- the hand-back result, including whether apply was automatic or user-confirmed,
  `staged, not committed` on success, every conflicted path on failure, the plan-marker result, and,
  for an automatic success, the applied path list plus the tracked-path and newly-added-file revert
  instructions above
- every retained worktree, every patch path, every cleanup failure, and the exact recovery commands
- every main-tree gate command and exit result labeled `authoritative host gates`, or that gates
  did not run without a successful apply; contestant self-reports keep their
  `contestant-reported checks` label and
  never merge into the main-tree results
- every implementer and reviewer invocation's usage and duration, using `usage unavailable` when
  omitted

State the cost plainly: the tournament launches one concurrent Codex write turn per Codex
contestant plus one sequential foreground Claude implementer run per Claude contestant, then one
review per non-empty completed contestant, so both providers' usage can be materially higher than
`/stereo:implement`. Report whether the tournament record is complete or remains resumable with
`/stereo:tournament --resume`. Repeat that no implementation record was written. Print the durable
`tournament-state.json` record path and name `tournament-state --clear` as the explicit reset. Point
to `/stereo:implement --review-only` for a fresh gate on the applied delta and to
`git -C "<mainRoot>" worktree list --porcelain` plus `git worktree remove --force` to find and remove
a worktree stranded by a crash. A Claude contestant has no job and cannot be cancelled with
`/stereo:cancel`; interrupting the session ends it and leaves its worktree discoverable with the same
worktree-list command. Never commit or push.
