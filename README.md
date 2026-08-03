# Claudex Stereo

[![CI](https://github.com/vsladkov/claudex-stereo/actions/workflows/ci.yml/badge.svg)](https://github.com/vsladkov/claudex-stereo/actions/workflows/ci.yml)

Claude and the Codex CLI as one signal: a Claude Code plugin that pairs the two ecosystems across
planning, implementation, adversarial review, and delegated tasks, with an independent model
choice for every role.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have. The commands run on a shared broker runtime with durable background jobs and
thread reservations, plus an optional stop-time review gate.

## Contents

- [What you get](#what-you-get) — the command surface, with per-command links
- [Requirements](#requirements) · [Install](#install) · [Quick start](#quick-start)
- [Usage](#usage) — every command in detail
- [Workspace role defaults](#stereoconfig) — durable routing choices for this repository
- [Typical flows](#typical-flows)
- [Model routing reference](#model-routing-reference) — aliases, prefixes, effort, model choice
- [Codex integration](#codex-integration)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq) · [Changelog and contributing](#changelog-and-contributing) · [License](#license)

## What you get

- [`/stereo:review`](#stereoreview) for a normal read-only review routed to Codex or Claude
- [`/stereo:adversarial-review`](#stereoadversarial-review) for a steerable challenge review
- [`/stereo:plan`](#stereoplan) and [`/stereo:implement`](#stereoimplement) for a checkpointed
  pair workflow with an independent Claude or Codex model choice at every step
- [`/stereo:plan-state`](#stereoplan-state) to read the latest reviewed plan before implementation
- [`/stereo:config`](#stereoconfig) to set durable per-workspace defaults for the four pair roles
- [`/stereo:quick`](#stereoquick) for both phases of the same pair workflow in one command when
  the task is small
- [`/stereo:tournament`](#stereotournament) to race 2–3 Claude or Codex implementers on the same
  approved plan in isolated worktrees and hand back the winner
- [`/stereo:rescue`](#stereorescue) and [`/stereo:transfer`](#stereotransfer) to delegate work and
  hand off sessions, with [`/stereo:status`, `/stereo:result`, and
  `/stereo:cancel`](#background-jobs) to manage background jobs
- [`/stereo:setup`](#stereosetup) to check readiness, provider configuration, and review-gate
  state
- [`/stereo:doctor`](#stereodoctor) to inspect workspace broker, durable state, worktrees,
  announcement watermark, and model-catalog drift

## Requirements

- **Codex authentication or a configured custom model provider.**
  - OpenAI-backed usage contributes to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 24 or later** (the plugin runs its TypeScript sources natively via Node's type stripping)
- **A Claude Code harness that exposes named `opus` and `fable` models for the default pipeline.**
  Three of its four roles use those models; if they are unavailable, use the
  [per-role model escape hatches](#troubleshooting).

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add vsladkov/claudex-stereo
```

From a local checkout, use its path instead:

```bash
/plugin marketplace add /path/to/claudex-stereo
```

Install the plugin:

```bash
/plugin install stereo@claudex-stereo
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/stereo:setup
```

`/stereo:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `stereo:codex-rescue` subagent and the six pair-workflow helpers—`stereo:planner`,
  `stereo:plan-reviewer`, `stereo:implementer`, `stereo:implementation-reviewer`,
  `stereo:reviewer`, and `stereo:adversarial-reviewer`—in `/agents`

## Quick start

A safe first run is a read-only background review of your current work:

```bash
/stereo:review --background
/stereo:status
/stereo:result
```

The review runs on Codex and counts against your Codex usage; `/stereo:status` and
`/stereo:result` read local job state and consume no model budget. Multi-file reviews can take a
while—that is what `--background` is for. Trimmed real `/stereo:status` output from one of this
repository's own background jobs:

```text
# Codex Status

Session runtime: direct startup
Review gate: disabled

Latest finished:
- task-ms3bgmam-3bpyi8 | completed | rescue | Codex Task
  Model: gpt-5.6-sol
  Phase: done
  Duration: 26s
  Tokens: job 463K in (99% cached) / 682 out (298 reasoning) · thread 3.8M in / 23K out (12K reasoning) · context 258K
  Resume in Codex: codex resume 019fa3e5-84a2-7f80-a715-6f7558dbfef8
```

`/stereo:result` prints the finished job's full final report plus the same `codex resume` line,
so completed work can be reopened directly in Codex. Job-management flags live under
[Background jobs](#background-jobs).

## Usage

### Model routing primer

Stereo's pair workflow is organized at four levels:

| Term  | Meaning                                            | Surface                                                                               |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Step  | One unit of work with no loop                      | Draft, plan-review, implement, or implementation-review mode                          |
| Phase | An automated draft/review or implement/review loop | `/stereo:plan` or `/stereo:implement`                                                 |
| Cycle | Both phases end to end                             | `/stereo:quick`                                                                       |
| Role  | The model performing one kind of work              | Planner, plan-reviewer, implementer, implementation-reviewer, or adversarial-reviewer |

Every multi-role command uses role-named model flags: `--planner`, `--plan-reviewer`,
`--implementer`, and `--implementation-reviewer`. Model selections use one addressing convention:

- `claude:session` runs the role inline when that role allows it.
- `claude:inherit` runs the contained foreground agent—a separate subagent with its own fresh
  context, isolated from this conversation—with its invocation-level model parameter omitted.
  `CLAUDE_CODE_SUBAGENT_MODEL` wins when set; otherwise the agent inherits the main
  conversation's model.
- `claude:sonnet`, `claude:opus`, `claude:haiku`, and `claude:fable` use a contained foreground
  Claude agent.
- Any other value is a Codex selection—a registry alias, a raw model id, or a qualified
  `model@provider` id—written throughout this documentation with the `codex:` prefix
  (`codex:sol`, `codex:glm`, `codex:gpt-5.6-sol@azure`). The prefix is optional in commands;
  the companion strips it once.

Defaults with no role flags:

| Role                    | `/stereo:plan` + `/stereo:implement`    | `/stereo:quick`      |
| ----------------------- | --------------------------------------- | -------------------- |
| Planner                 | `claude:opus`                           | `claude:session`     |
| Plan reviewer           | `claude:fable`                          | `claude:fable`       |
| Implementer             | stored model, else `codex:sol` at `max` | `codex:sol` at `max` |
| Implementation reviewer | `claude:fable`                          | `claude:fable`       |

Codex aliases, prefix semantics, effort rules, reviewer continuation, and per-role model choice
live in the [Model routing reference](#model-routing-reference).

### `/stereo:review`

Runs a normal read-only implementation-quality review on your current work. Codex selections use
the same built-in reviewer as running `/review` inside Codex directly; Claude selections use
Stereo's standard structured review brief.

> [!NOTE]
> Code review especially for multi-file changes might take a while. For a Codex selection, it's
> generally recommended to run it in the background; Claude selections always run in the
> foreground.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--scope auto|working-tree|branch` to select the review target. `auto` (the default) reviews the
working tree when `git status --short --untracked-files=all` is non-empty; otherwise it reviews the
default-base branch diff. `--base <ref>` takes precedence over `--scope`. The `staged` and
`unstaged` scopes are rejected.

The command supports `--wait`, `--background`, and `--model` across both routes. Codex selections
use Codex's built-in reviewer. `claude:session`, `claude:inherit`, `claude:sonnet`, `claude:opus`,
`claude:haiku`, and `claude:fable` run Stereo's standard review brief in the foreground against the
same `review-output.schema.json` contract used by
[`/stereo:adversarial-review`](#stereoadversarial-review). A
`--background --model claude:*` combination is rejected because Claude agent runs are bound to the
current session; durable background reviews remain Codex-only. `--effort` is rejected on both
routes. The command takes no custom focus text on either route; use adversarial review for a
steerable or challenge review.

`--pr <n>` is user-side sugar for reviewing a checked-out pull request. When the optional `gh` CLI
is installed and authenticated, Stereo resolves the PR's base and verifies that `HEAD` exactly
matches the PR head before reviewing. It never checks out or otherwise mutates the worktree; when
the heads differ, run `gh pr checkout <n>` yourself. Without `gh`, check out the PR branch and pass
`--base <ref>` manually.

Examples:

```bash
/stereo:review
/stereo:review --base main
/stereo:review --pr 42
/stereo:review --background
/stereo:review --model claude:opus
```

This command is read-only and will not perform any changes. When run in the background you can
use [`/stereo:status`](#background-jobs) to check on the progress and
[`/stereo:cancel`](#background-jobs) to cancel the ongoing task.

### `/stereo:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different
approach would have been safer or simpler.

It uses the same review target selection and `--scope`/`--base` rules as `/stereo:review`.

It also supports `--wait`, `--background`, `--model`, `--effort`, and the same `--pr <n>` checkout
and optional-`gh` behavior as normal review. Unlike `/stereo:review`, it can take extra focus text
after the flags. Codex models can run in the foreground or background; all Claude selections,
including `claude:session` and `claude:inherit`, use the same adversarial brief and structured
output contract in the foreground. `--background --model claude:*` is rejected
([Background jobs](#background-jobs)).

Adversarial-review effort precedence is explicit `--effort`, then the named model's pair default
when `--model` was supplied, then Codex's configured default when no model was named. No workspace
role default applies because adversarial review is not one of the four pair roles. `--effort` with
a `claude:*` route is rejected rather than silently ignored.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/stereo:adversarial-review
/stereo:adversarial-review --base main challenge whether this was the right caching and retry design
/stereo:adversarial-review --pr 42 --effort high challenge the authorization boundary
/stereo:adversarial-review --background look for race conditions and question the chosen approach
/stereo:adversarial-review --model claude:opus challenge the rollback design
/stereo:adversarial-review --model claude:inherit challenge the session's assumptions with fresh context
```

This command is read-only. It does not fix code.

### `/stereo:config`

Shows or changes this repository's durable model and Codex effort defaults for the planner, plan
reviewer, implementer, and implementation reviewer. The model flags are `--planner`,
`--plan-reviewer`, `--implementer`, and `--implementation-reviewer`; append `-effort` to each role
flag to set its Codex effort. Selections use the same `claude:*`, `codex:*`, alias, raw model, and
qualified provider forms as the pair commands.

An explicit command flag wins over the stored workspace default, which wins over that command's
built-in default. For the implementer, the workspace default also wins over the model recorded by
the last Codex plan review. Invalid hand-edited entries produce warnings and fall back to the
built-in default.

```bash
/stereo:config
/stereo:config --planner codex:terra --planner-effort high
/stereo:config --implementation-reviewer claude:opus
/stereo:config --clear planner-effort
/stereo:config --clear roles
```

Defaults live in `~/.codex/companion-state/<workspace>/state.json`, outside the repository, and
survive plugin reinstalls. A custom `CODEX_HOME` relocates that durable state. Reading config in a
fresh workspace does not create state files.

### `/stereo:plan`

Starts the planning half of the pair workflow. The current Claude session remains the orchestrator,
while the plan drafter and adversarial reviewer can each be either Claude or Codex:

| Step        | Flag              | Default        | Claude execution                       | Codex execution                 |
| ----------- | ----------------- | -------------- | -------------------------------------- | ------------------------------- |
| Plan draft  | `--planner`       | `claude:opus`  | Foreground read-only planner subagent  | Fresh read-only task            |
| Plan review | `--plan-reviewer` | `claude:fable` | Foreground read-only reviewer subagent | Persistent `plan-review` thread |

Both roles accept the full addressing convention from the
[Model routing primer](#model-routing-primer): the six `claude:*` values plus any Codex alias,
raw model id, or qualified `model@provider` id, written here with the optional `codex:` prefix.

`--planner-effort` and `--plan-reviewer-effort` set effort for their Codex-routed role.
`--effort` is the fallback for either role when its specific flag is absent. A role effort flag is
rejected when that role is Claude-routed or excluded by `--draft-only`/`--review-only`. Under the
Claude-routed defaults, a command-wide `--effort` is accepted but inert and reported as such.
`--slot <name>` selects the durable plan slot and defaults to `default`; names are lowercased and
may use letters, digits, hyphens, and underscores.

With no new flags, a fresh contained `claude:opus` planner drafts and a contained `claude:fable`
reviewer gates the plan. Claude revises the plan between rounds, rebuts findings it can disprove,
and may descope scope-expanding findings into `## Out of scope` as documented residuals. Reviews
are judged against the plan's own `## Goal` and `## Out of scope`.

Named-Claude plan reviewers follow the [reviewer continuation](#reviewer-continuation) rule
across later rounds.

The review loop is capped at 6 rounds by default (healthy reviews approve in 2-5); use
`--max-plan-rounds <n>` to change the cap. At the cap Claude offers to split the plan rather than
iterate forever.

Use `--draft-only` to run and store just the draft step. The stored plan has verdict `draft` and
review round 0, so implementation still presents the unapproved-plan gate. Use `--review-only` to
load the stored plan, run one fresh review round, persist its actual verdict, and stop without
revising it. Add `--plan-file <path>` to `--review-only` to intake an external plan using its exact
bytes and an independent round 1. Before a full phase, draft-only run, or external intake replaces
an unimplemented plan in its target slot, Stereo asks whether to replace it, choose a new named
slot, or stop. Plain `--review-only` does not replace the stored plan and skips that guard. Missing
canonical headings warn but do not reject an external document. The two modes conflict; each also
rejects flags for a role or loop it does not run.

Examples:

```bash
/stereo:plan add rate limiting to the public API
/stereo:plan --plan-reviewer codex:sol add rate limiting to the public API
/stereo:plan --plan-reviewer codex:sol add rate limiting to the public API
/stereo:plan --planner claude:haiku add a validation check
/stereo:plan --plan-reviewer claude:opus refactor the retry logic
/stereo:plan --max-plan-rounds 3 refactor the retry logic
/stereo:plan --plan-reviewer codex:terra --effort high migrate the config loader
/stereo:plan --planner codex:mini --planner-effort high --plan-reviewer codex:sol --plan-reviewer-effort max migrate the config loader
/stereo:plan --draft-only draft a migration plan
/stereo:plan --slot api-rate-limit add rate limiting to the public API
/stereo:plan --review-only --plan-reviewer claude:opus
/stereo:plan --review-only --plan-file ./approved-plan.md
```

Planning is read-only: nothing is implemented until you run
[`/stereo:implement`](#stereoimplement). Codex-reviewed plans retain their review thread.
Claude-reviewed plans—the default—are stored in the same durable state without a Codex thread, so
later implementation starts fresh with the complete plan embedded.

### `/stereo:implement`

Implements the plan reviewed by [`/stereo:plan`](#stereoplan). The implementer and implementation
reviewer are independently selectable while the current Claude session keeps ownership of the
gates, verification, fix loop, and final report:

| Step                  | Flag                        | Default                     | Claude execution                      | Codex execution      |
| --------------------- | --------------------------- | --------------------------- | ------------------------------------- | -------------------- |
| Implementation        | `--implementer`             | Stored model or `codex:sol` | Foreground file-edit-only implementer | Workspace-write task |
| Implementation review | `--implementation-reviewer` | `claude:fable`              | Foreground read-only reviewer         | Fresh read-only task |

The same Claude and Codex model values accepted by `/stereo:plan` work here, except
`claude:session` is not a valid implementer: Claude writes are always isolated in the contained
file-edit agent. `--implementer-effort` and `--implementation-reviewer-effort` override their
respective Codex roles; `--effort` remains the fallback for either. A role effort flag is rejected
for a Claude-routed role or a mode that does not run that role.
`--slot <name>` selects the stored plan to implement and defaults to `default`. Resume takes its
slot from the durable implementation record, so `--slot` and `--resume` cannot be combined.

Use [`/stereo:plan-state`](#stereoplan-state) to read the complete stored plan, its review
metadata, open questions, and residual risks before starting implementation.

With no new flags, Codex implements with the stored model in the stored review thread when one
exists, and a contained `claude:fable` reviewer gates every round. The default Claude-reviewed
plan stores no Codex model or thread, so implementation starts a fresh `codex:sol` thread at `max` with
the complete plan embedded and a truthful outside-thread preamble; `--fresh` is redundant on that
path. The fix loop is capped at 4 rounds by default; use `--max-fix-rounds <n>` to change the cap.

Stored plan-review findings travel with the plan into implementation and implementation review:
they are binding known findings on an unapproved run and advisory context on an approved one.

Use `--implement-only` to run preflight, implementation, and host-side checks, then stop before
review. Use `--review-only` to treat the current dirty and untracked worktree as the complete
implementation delta, run one implementation-review step, and stop without applying fixes. A
clean worktree has nothing to review.

Use `--review-only --base <ref>` to review the committed `<ref>...HEAD` range instead. Stereo
resolves the merge base and reviews the full committed range, including committed versions of
files that are also dirty on disk. Uncommitted working-tree content remains out of scope and is
listed explicitly; overlaps are warned because the on-disk file differs from the committed content
being reviewed. `--base` is rejected outside review-only mode, and `--scope` is not accepted by
`/stereo:implement`.

`--resume` re-enters an interrupted implementation/review/fix phase from
`$CODEX_HOME/companion-state/<workspace>/implement-state.json`. The bounded record includes the
baseline and baseline-dirty paths, selected implementer/model/effort, implementation thread,
latest implementation or fix background job ID, completed review rounds and fix judgments,
summarized reports and host results, the stored-plan fingerprint, and timestamps. Resume checks
the recorded job first: it can wait for a still-running worker or fetch a completed worker's real
report before reviewing. It then re-reads the current delta and reruns host checks; historical host
summaries are never treated as current evidence.

When the stored plan changed, resume shows both fingerprints and asks before using the current
plan. When `HEAD` moved but the baseline still resolves, it preserves that baseline for attribution
and asks before continuing; when the baseline vanished, it stops as stale. A complete record
reports its final round and offers to start fresh, clear the record, or stop. Accepted full phases
mark the record complete. A new non-resume run deliberately replaces an older record; explicit
clearing is otherwise user-chosen. The first resumed reviewer is always freshly and fully briefed
because agent continuation never crosses command runs.

`--isolated` runs implementation in a throwaway detached worktree under the OS temporary
directory, confining Codex writes there while durable state, jobs, and the shared broker remain
keyed to the main workspace, so `/stereo:status` works as usual. Review and host checks target the
worktree, then Stereo creates a binary patch and asks before handing it back with
`git apply --3way`; it never creates a commit. Isolation is rejected with `--review-only` and
`--base`, while `--resume` follows the worktree recorded by the interrupted phase. Use
[`/stereo:tournament`](#stereotournament) for the multi-implementer form of the same isolated
worktree and patch hand-back machinery.

Codex implementation-review tasks pass the shipped implementation-review schema to the runtime,
so their final messages are schema-constrained before the command performs its normal validation
and retry checks. Claude routes retain command-side validation.

Named-Claude implementation reviewers follow the same
[reviewer continuation](#reviewer-continuation) rule across fix-loop rounds inside one command
run; Codex implementation-review rounds stay fresh by design.

Claude implementation is deliberately file-edits-only: the agent has no shell, network, process,
or git tool. Before edits, the command detects plan steps requiring version scripts, package
installation, code generation, migrations, or interactive processes and asks whether to switch to
Codex, leave those command steps for you, or stop. It never executes shell text requested by a
model.

Examples:

```bash
/stereo:implement
/stereo:implement --implementer claude:sonnet
/stereo:implement --implementation-reviewer codex:terra
/stereo:implement --implementation-reviewer codex:sol
/stereo:implement --implementation-reviewer claude:session
/stereo:implement --implementer codex:sol --implementation-reviewer claude:opus --effort high
/stereo:implement --implementer codex:mini --implementer-effort xhigh --implementation-reviewer codex:sol --implementation-reviewer-effort max
/stereo:implement --max-fix-rounds 3
/stereo:implement --fresh
/stereo:implement --implement-only
/stereo:implement --slot api-rate-limit --implement-only
/stereo:implement --resume
/stereo:implement --isolated
/stereo:implement --review-only --implementation-reviewer claude:opus
/stereo:implement --review-only --base main
```

The final report lists the stored `residualRisks`, verification results, selected models, and any
user-owned command steps. Nothing is committed; you review and commit the result yourself.

> [!WARNING]
> The pair workflow iterates until accepted by default, which can take a long time and consume
> usage limits quickly. Default planning, plan review, and implementation review consume Claude
> usage, while implementation and fix rounds consume Codex usage at `max`. Start from a clean
> worktree, use `--implementation-reviewer claude:session` for the cheaper inline path, bound the
> loops with
> `--max-plan-rounds`/`--max-fix-rounds` if you want a budget, and consider
> `/stereo:setup --disable-review-gate` during long pair sessions.

### `/stereo:plan-state`

Shows the complete plan in the selected durable slot, together with its verdict, review round,
model and Codex thread, update time, review findings, open questions, residual risks, and the
`implementedAt` marker when present. The default slot is selected when `--slot` is absent, and
`/stereo:quick` always uses that slot. The marker means a full implementation phase finished with
an accepted review; it does not mean the work was committed or merged. Findings are rendered as a
compact severity-and-title list; `/stereo:plan-state --json` returns their complete stored objects.

```bash
/stereo:plan-state
/stereo:plan-state --list
/stereo:plan-state --slot api-rate-limit
/stereo:plan-state --open
/stereo:plan-state --slot api-rate-limit --open
/stereo:plan-state --clear
/stereo:plan-state --mark-implemented
```

Without flags, the command only renders the default plan in the terminal. Use `--list` to inventory
all slots and see which one owns the current implementation record. Use `--slot <name>` to select a
named slot for showing, opening, clearing, or marking it implemented. `--open` refreshes
`pair-plan.md` for the default slot or `pair-plan-<slot>.md` for a named slot in the durable state
directory, then opens it in VS Code through the `code` CLI. The command always prints the exported
path, so you can open the file manually when `code` is unavailable.

`--clear` asks for confirmation and removes both artifacts for the selected slot. It removes the
single implementation record only when that record belongs to the cleared slot. `--mark-implemented`
is normally invoked automatically after a successful full `/stereo:implement` or `/stereo:quick`
phase; storing a new plan or review revision clears the marker.

The durable state directory is normally `~/.codex/companion-state/<workspace>/`, outside the
repository. A custom `CODEX_HOME` inside the repository places all durable companion state there
instead. If no reviewed plan is stored for the repository, the command directs you to run
`/stereo:plan` first.

### `/stereo:quick`

Runs the complete cycle—both phases end to end—in one command for a small, single-feature task.
Each of the four roles is independently routable. By default, the current Claude session drafts, `claude:fable`
reviews the plan, `codex:sol` implements at `max`, and a contained `claude:fable` reviews the
implementation. The planner stays inline because the scope gate already grounds the task in this
session.

Quick deliberately has no `--resume`: an interrupted quick run restarts from the beginning. Use
`/stereo:plan` plus `/stereo:implement` for longer work that needs resumable implementation state.

Quick automatically pauses after 2 plan-review rounds and 2 implementation fix rounds. At the plan
cap you can keep iterating, implement the reviewed but unapproved plan with its findings carried
forward, or stop. Choosing keep iterating continues automatically through rounds 3-5, with the
reviewer carried forward per [reviewer continuation](#reviewer-continuation). Round 6 is an
absolute safeguard and
offers only implement anyway or stop. Approved plans also carry their review findings forward as
advisory context. Dirty worktrees and exhausted fix rounds still produce explicit safety gates. If
the task needs a plan longer than roughly 120 lines or crosses multiple features or subsystems,
quick stops before review and directs you to
[`/stereo:plan`](#stereoplan).

Use the same four role flags as the phase commands:

| Role                    | Model flag                  | Effort flag                        | Default                                                                                               |
| ----------------------- | --------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Planner                 | `--planner`                 | `--planner-effort`                 | `claude:session`                                                                                      |
| Plan reviewer           | `--plan-reviewer`           | `--plan-reviewer-effort`           | `claude:fable`                                                                                        |
| Implementer             | `--implementer`             | `--implementer-effort`             | `codex:sol` at `max` after default Claude review; latest Codex plan-review model and effort otherwise |
| Implementation reviewer | `--implementation-reviewer` | `--implementation-reviewer-effort` | `claude:fable`                                                                                        |

Because the default Claude plan reviewer leaves no Codex thread to resume, quick starts a fresh
Codex implementation task by default. Its implementer is `codex:sol` with `--implementer-effort`, then
command-wide `--effort`, then `max`, and the recap names that effective choice before writes
begin. A Codex plan reviewer instead supplies its resolved model, effort, and resumable thread.
For every Codex role, the matching role effort flag overrides `--effort`. Claude review verdicts
are stored before quick transitions or stops, so later `/stereo:implement` gates remain accurate.

```bash
/stereo:quick fix the retry delay calculation
/stereo:quick --planner claude:haiku --plan-reviewer codex:terra --effort high add a validation check
/stereo:quick --plan-reviewer claude:sonnet --implementation-reviewer claude:opus fix a small bug
/stereo:quick --plan-reviewer codex:sol fix a small bug
/stereo:quick --plan-reviewer codex:mini --plan-reviewer-effort xhigh --implementer codex:sol --implementer-effort high fix a small bug
```

The latest reviewed plan is stored normally, so an interrupted approved run can resume with
`/stereo:implement`. Nothing is committed or pushed.

### `/stereo:tournament`

Runs one already-approved stored plan through 2 or 3 independent implementers. With no
`--implementer` flags, the default lineup uses the workspace `implementer` model for `c1` when it is
valid and Codex-routed, otherwise `codex:sol`; `c2` remains `claude:opus`. The Codex contestant uses
that model's pair-default effort unless `--effort` or an applicable workspace implementer effort
overrides it; an effort stored alongside a Claude-routed implementer remains inert. Claude runs at
full session strength and has no effort dial. Each contestant starts in its own detached temporary
worktree at the same `HEAD`, so the main working tree stays untouched while contestants run and their
evidence is reviewed. Two contestants are the minimum for a comparison; three is the cap because
every extra contestant adds an implementation run and an independent review, increasing cost,
rate-limit pressure, and cleanup work. Use `/stereo:implement` when you want one implementer.

Contestants may be Codex selections or `claude:sonnet`, `claude:opus`, `claude:haiku`,
`claude:fable`, and `claude:inherit`. `claude:session` is rejected because Claude writes stay in the
contained file-edit agent. Codex contestants launch first as concurrent detached jobs; Claude
contestants then run one at a time in the foreground before Codex polling resumes.
`--implementer-effort` is Codex-only and requires an all-Codex lineup, while `--effort` covers every
Codex contestant in a mixed lineup. The one selected implementation reviewer may be Claude or
Codex, but it receives each contestant independently in declaration order: every verdict is a fresh
single-round review with no contestant or reviewer history carried into the next one. Stereo then
shows the models, diffstats, implementer reports, review verdicts, and usage side by side. When
exactly one contestant is acceptable, or when every acceptable contestant produced a byte-identical
delta, Stereo selects the winner automatically. When no patched path overlaps a currently dirty
path, `HEAD` has not moved, and Git's 3-way preflight succeeds, it also applies that patch itself.
When several acceptable contestants disagree or none is acceptable, Stereo shows the comparison
and asks which delta to hand back. Nothing is ever committed or pushed, and every losing delta is
still preserved as a patch file.

A Claude contestant is file-edits-only with no shell, so shell-requiring plan steps appear as
deviations in its report and comparison row. A denied or failed Claude contestant is withdrawn with
its worktree retained. It has no job id, so it does not appear in `/stereo:status` or
`/stereo:cancel`.

Tournament worktrees are fresh checkouts and often lack gitignored dependencies or generated
artifacts, so Stereo does not run the host gate suite per contestant and reviewers are told that
the deltas are unverified. After any successful `git apply --3way` hand-back, whether automatic or
user-confirmed, the normal repository gates run once in the main tree. This makes tournaments most
useful when tests do not need gitignored artifacts—or when you are comfortable treating the
post-hand-back gates as the real verdict.

Before removing any completed losing worktree, Stereo writes its binary delta to a patch file
outside every repository tree and prints that path, so a losing implementation remains
recoverable. Failed or cancelled contestants retain their worktrees so partial deltas are not
destroyed. A crash or closed session can also strand worktrees; find them with
`git worktree list --porcelain` and remove an unwanted path with `git worktree remove --force`.

The tournament writes a durable tournament record beside the stored plan and can be re-entered with
`/stereo:tournament --resume`; it never writes the implementation record. A fully successful
hand-back—an acceptable winner, a successful apply, and every identifiable main-tree gate green—marks
the stored plan implemented. Codex contestants resume from durable jobs. A Claude contestant already
running when the session ended cannot be resumed and is judged on its worktree delta alone. Clearing
the stored plan does not clear the tournament record; use the tournament-state clear action as an
explicit reset. A complete run costs one concurrent Codex write turn per Codex contestant plus one
sequential foreground Claude implementer run per Claude contestant, and one reviewer invocation per
non-empty completed contestant, so check both providers' usage limits before racing expensive
models.

```bash
/stereo:tournament
/stereo:tournament --resume
/stereo:tournament --implementer codex:sol --implementer claude:opus
/stereo:tournament --implementer codex:sol --implementer codex:mini
/stereo:tournament --implementer codex:sol --implementer codex:sol --implementer-effort high --implementer-effort max
/stereo:tournament --slot api-rate-limit --implementer codex:sol --implementer codex:terra --implementation-reviewer claude:opus
```

### `/stereo:rescue`

Hands a task to Codex through the `stereo:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's
> generally recommended to force the task to be in the background or move the agent to the
> background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and
`--fresh`, the plugin can offer to continue the latest rescue thread from this session,
falling back to the repository's latest only when no session id is known.

Examples:

```bash
/stereo:rescue investigate why the tests started failing
/stereo:rescue fix the failing test with the smallest safe patch
/stereo:rescue --resume apply the top fix from the last run
/stereo:rescue --model codex:mini --effort medium investigate the flaky integration test
/stereo:rescue --model codex:mini fix the issue quickly
/stereo:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `claude:*` models are rejected because rescue is a Codex bridge. For Claude-routed work, use
  `/stereo:quick` with `--implementer claude:<alias>`,
  `/stereo:implement --implementer claude:<alias>`, or
  `/stereo:adversarial-review --model claude:<alias>`.
- built-in aliases such as `codex:mini` are listed in the [Codex alias table](#codex-model-aliases);
  third-party aliases are listed under [Other model providers](#other-model-providers)
- follow-up rescue requests can continue this session's latest Codex task

### `/stereo:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a
`codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to
continue that same context directly in Codex.

The direction is deliberate: `/stereo:transfer` moves a Claude Code session into a resumable Codex
thread and takes no `--model` because the destination runtime is fixed; Codex threads resume in
Codex rather than transferring back into Claude, so use
`/stereo:adversarial-review --model claude:<alias>` or a Claude role route in `/stereo:plan`,
`/stereo:implement`, or `/stereo:quick` when Codex work needs Claude-side review or continuation.

Examples:

```bash
/stereo:transfer
/stereo:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically;
`--source` is available as a manual override. The transfer uses Codex's external-agent session
importer, so it follows the same conversion rules as importing Claude history in the Codex App
and creates visible turns that can be continued in the App or TUI. The source must be under
`~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded
before using this command.

### Background jobs

`--background` runs long Codex work as a durable job scoped to this repository, so it survives
turn boundaries and can be checked from any later prompt. Background jobs are always Codex jobs:
Claude agent runs are session-bound and never appear in `/stereo:status`, which is why
`/stereo:adversarial-review` rejects `--background` with a `claude:*` model.

At SessionStart, Stereo reads only this durable local index and adds a short context note for
active jobs plus terminal jobs completed since the previous session. It is silent for untouched
or jobless workspaces, never reads job logs or contacts the broker, and cannot block session
startup. Active jobs may be repeated after resume, clear, compact, or fork; finished jobs are
watermarked and announced once in normal use.

**`/stereo:status`** — the flagless listing shows running and recent Codex jobs for this
repository, filtered to the current session when a session ID is known; an explicit job ID looks
up any job in this repository regardless of session. `--all` keeps that scope but includes every
older finished job instead of limiting the past-finished list to the eight most recent. `--wait`
blocks on one job and requires a job ID; `--timeout-ms <ms>` and `--poll-interval-ms <ms>` tune
that wait. `--verbose` adds log-file paths, timestamps, and longer progress previews.

**`/stereo:status --usage`** — sums per-job token usage from the retained local job index and groups
it by job kind and model, with rendered tables or `--json`. The index retains at most 50 jobs, so
this is a bounded window rather than all-time history. Without `--all`, usage is scoped to the
current session when a session ID is known; here `--all` widens scope to every retained workspace
job, unlike its listing meaning above. Only `tokenUsage.job` is summed. The cumulative
`tokenUsage.thread` value is deliberately excluded because resumed jobs can share a thread and
would otherwise be counted repeatedly. These totals are local job accounting, not Codex account
usage, billing, or Claude-side agent usage.

**`/stereo:result`** — shows the final stored Codex output for a finished job. When available, it
also includes the Codex session ID so you can reopen that run directly in Codex with
`codex resume <session-id>`. Add `--report` to print only the stored report text.

**`/stereo:cancel`** — cancels an active background Codex job.

```bash
/stereo:status
/stereo:status --usage
/stereo:status --usage --all --json
/stereo:status task-abc123 --wait --timeout-ms 60000 --poll-interval-ms 1000
/stereo:status --all
/stereo:result task-abc123
/stereo:result task-abc123 --report
/stereo:cancel task-abc123
```

### `/stereo:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

The setup report covers:

- Node, npm, and Codex availability, Codex authentication, and the effective write sandbox
- the active model provider, each configured provider's environment-key status, and per-alias
  readiness
- the session runtime, stranded thread reservations, review-gate state, and configured role
  defaults
- account rate limits, actions taken, and next steps when present

You can also use `/stereo:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/stereo:setup --enable-review-gate
/stereo:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

### `/stereo:doctor`

Inspects the current workspace's runtime and durable state after setup is healthy. The report embeds
the normal `/stereo:setup` checks, then shows the broker record and `broker.log`, the resolved
`$CODEX_HOME/companion-state/<workspaceKey>/` directory, implementation-resume state, stranded
`stereo-worktrees` entries, the SessionStart job-announcement watermark, and drift between Stereo's
OpenAI model registry and Codex's cached model catalog.

The command is read-only unless you explicitly reset the announcement watermark:

```bash
/stereo:doctor
/stereo:doctor --reset-job-announcements
```

An unavailable Codex model cache is reported as not checked, not as a failure. Doctor prints exact
paths and cleanup commands but does not remove worktrees, restart brokers, or clear implementation
records automatically.

## Typical flows

**Review before shipping**

```bash
/stereo:review
```

**Hand a problem to Codex**

```bash
/stereo:rescue investigate why the build is failing in CI
```

**Small fix, one command**

```bash
/stereo:quick fix the retry delay calculation
```

**Plan together, then let Codex build**

```bash
/stereo:plan add rate limiting to the public API
/stereo:implement
```

**Run every step by hand**

```bash
/stereo:plan --draft-only add rate limiting to the public API
/stereo:plan --review-only
/stereo:implement --implement-only
/stereo:implement --review-only
```

If the one-round plan review returns `needs-revision`, ask the current session to revise and
re-store the plan before reviewing it again, or run the full `/stereo:plan` phase to use its
automated revision loop.

**Full-discovery planning sweep**

```bash
/stereo:plan --draft-only --slot rate-limit-opus add rate limiting to the public API
/stereo:plan --draft-only --slot rate-limit-fable --planner claude:fable add rate limiting to the public API
/stereo:plan-state --list
/stereo:plan-state --slot rate-limit-opus --open
/stereo:plan-state --slot rate-limit-fable --open
```

Run two independent `--draft-only` passes with different planners, compare and merge their
discoveries at the findings level, then plan once and review normally. Each draft remains in its
own durable slot, and each `--open` writes a separate `pair-plan-<slot>.md` export, so no manual
copy is needed between passes.

**Start something long-running**

```bash
/stereo:adversarial-review --background
/stereo:rescue --background investigate the flaky test
```

Then check in with:

```bash
/stereo:status
/stereo:result
```

## Model routing reference

### Choosing models per role

These are dogfooded defaults, not enforcement: every role flag remains free-form.

Use `/stereo:config` to replace any of these defaults for one repository. Resolution is explicit
role flag > stored workspace role default > the built-in listed below. The implementer's stored
workspace model additionally outranks the model recorded by the latest plan review because it is
durable repository intent.

| Situation                            | Planner                     | Plan reviewer    | Implementation reviewer |
| ------------------------------------ | --------------------------- | ---------------- | ----------------------- |
| Default and most work                | `claude:opus`               | `claude:fable`   | `claude:fable`          |
| Cross-ecosystem or budget-split work | `claude:session` (or Codex) | `codex:sol`      | `codex:sol`             |
| Cheapest implementation gate         | Task-appropriate            | Task-appropriate | `claude:session`        |

For most work, use the defaults:

```bash
/stereo:plan add rate limiting to the public API
```

A fresh contained planner is unanchored by the session's earlier conclusions, and the strongest
model belongs at the approval gate because a wrongly approved plan costs more than an extra
revision round. The implementation reviewer defaults to `claude:fable`, the same model that gates
plans, because it is the last gate before you commit and the one review the orchestrating session
should not perform: the session produced the delta, wrote the fix instructions, and has every
reason to read its own work generously. Stored plan-review findings travel into every
implementation-review brief — labeled advisory on approved runs and binding on unapproved
ones — so what a contained reviewer misses is the argument around them, not the findings.

Each route prices the workflow differently:

| Route                                                               | Budget                  | Cost profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults: `claude:opus` + `claude:fable` gates                      | Claude                  | Round 1 of each review spawns a fresh contained reviewer that reads from scratch; in dogfooded runs, fresh contained `claude:fable` review turns have ranged from roughly 40k tokens for a small documentation delta to 130k for a full plan-review round—cost scales with how much the reviewer must read. Later rounds follow [reviewer continuation](#reviewer-continuation). A Claude-reviewed plan leaves no resumable Codex review thread, so `/stereo:implement` starts fresh with the complete plan embedded. |
| `--plan-reviewer codex:sol` / `--implementation-reviewer codex:sol` | Split across ecosystems | Moves review cost to the OpenAI budget, restores a resumable Codex review thread at the plan gate, and buys cross-ecosystem review independence.                                                                                                                                                                                                                                                                                                                                                                      |
| `--implementation-reviewer claude:session`                          | Claude, inline          | The cheapest implementation gate, but not independent of the session that produced the work.                                                                                                                                                                                                                                                                                                                                                                                                                          |

One flag restores a Codex plan-review gate, budget split, and resumable review thread; selecting
the inline planner as well restores the full previous behavior:

```bash
/stereo:plan --plan-reviewer codex:sol <task>
/stereo:plan --planner claude:session --plan-reviewer codex:sol <task>
```

Containment is not cross-ecosystem independence
([deliberate boundaries](#deliberate-boundaries)). If the harness does not expose named `opus`
or `fable` models, use the per-role escape hatches under [Troubleshooting](#troubleshooting).

### Prefix semantics

The prefix names the executing runtime, not the model vendor. `claude:` remains required for its
closed six-value set so those selections are distinguishable from the open Codex passthrough;
`codex:` is optional in commands because the Codex side cannot be enumerated and includes
third-party providers. This documentation writes every Codex-side selection with the `codex:`
prefix for symmetry with `claude:`; the companion strips it once and resolves the selection to
a model id. Stored state, status output, and reports carry those resolved ids —
`Model: gpt-5.6-sol` in tool output is `codex:sol`'s resolved id, never a third spelling.

### Codex model aliases

| Alias         | Model id        | Pair-role effort default |
| ------------- | --------------- | ------------------------ |
| `codex:mini`  | `gpt-5.4-mini`  | `xhigh`                  |
| `codex:sol`   | `gpt-5.6-sol`   | `max`                    |
| `codex:terra` | `gpt-5.6-terra` | `max`                    |
| `codex:luna`  | `gpt-5.6-luna`  | `max`                    |

Third-party aliases (`codex:kimi`, `codex:qwen`, `codex:deepseek`, and `codex:glm`) omit the effort default and are listed
under [Other model providers](#other-model-providers).

### Effort rules

`--effort` remains the command-wide Codex default. Multi-role commands also accept the matching
role flags: `--planner-effort`, `--plan-reviewer-effort`, `--implementer-effort`, and
`--implementation-reviewer-effort`. For each Codex-routed role, its role flag wins over
`--effort`, which wins over the stored workspace role effort, then any applicable stored-plan
effort, then the model-pair default. Stored-plan effort applies to implementation only when the
stored-plan model also supplied the implementer model; an explicit or workspace-supplied model
drops it. The model-pair default comes from the alias table: `max` for `codex:sol`, `codex:terra`,
and `codex:luna`, `xhigh` for `codex:mini`, and `max` for unregistered raw `gpt-*` ids. Non-OpenAI
selections omit an effort override. A role effort flag is rejected when its selected role is
Claude-routed, and a stored effort under a Claude-routed model is reported as inert.
Stored plans record Codex `model`/`effort` only. The durable Claude-side equivalent is
`/stereo:config --implementer claude:<alias>`, whose workspace default outranks the stored-plan
model.

Stereo's Claude role agents intentionally omit the agent-definition `effort` field, so they
inherit the session's effort and extended-thinking configuration. Subagents have no separate
thinking setting, and `ultrathink` is a main-turn keyword only; Stereo never translates Codex
effort flags into prompt keywords. Claude agent definitions can set
`effort: low|medium|high|xhigh|max` (subject to model availability), but a modified copy under
`.claude/agents/` is only manually invocable: it cannot shadow the plugin-scoped `stereo:*` agents
the commands launch. Model selection is the available per-invocation Claude strength control.

### Reviewer continuation

Named-Claude plan and implementation reviewers keep the same contained agent across later review
rounds within one command run, when the running Claude Code harness supports follow-ups: round 1
is always a fresh, fully briefed reviewer, and later rounds send a compact round message instead
of the full brief. Unsupported, erroring, or malformed continuations fall back to the fully
re-briefed stateless review used previously, and continuation never crosses command runs. Codex
plan reviewers resume their persistent `plan-review` thread instead. Codex implementation-review
rounds remain fresh read-only tasks by design: the fully filled brief travels with every round,
so resuming would add thread history without reducing payload cost and would weaken the
cross-ecosystem reviewer's per-round independence.

### Role briefs and guidance files

Stereo uses one canonical brief per role, regardless of which ecosystem performs it:

| Role                    | Canonical brief                                   | Filled by                              | Consumers                                        |
| ----------------------- | ------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Planner                 | `plugins/stereo/prompts/plan-draft.md`            | Orchestrating command                  | Plan and Quick drafts, all routes                |
| Plan reviewer           | `plugins/stereo/prompts/plan-review.md`           | Runtime for Codex; command for Claude  | Plan and Quick review rounds, all routes         |
| Reviewer                | `plugins/stereo/prompts/review.md`                | Command on Claude; Codex uses built-in | `/stereo:review`                                 |
| Implementation reviewer | `plugins/stereo/prompts/implementation-review.md` | Command; Codex runtime enforces schema | Implement and Quick review rounds, all routes    |
| Adversarial reviewer    | `plugins/stereo/prompts/adversarial-review.md`    | Runtime for Codex; command for Claude  | Adversarial review, both ecosystems              |
| Implementer             | Equivalent prompt and contained-agent contracts   | Route-specific by containment boundary | Implement and Quick implementation and fix turns |

Codex reads repository-root `AGENTS.md` guidance, while Claude Code reads `CLAUDE.md`. A
single-file repository can keep `AGENTS.md` canonical and make `CLAUDE.md` import it with
`@AGENTS.md`. A two-file repository can instead point or mirror the applicable guidance in both;
this repository keeps `CLAUDE.md` canonical and a separate `AGENTS.md` with Codex-specific notes.

Live-source access follows each platform's own configuration. Codex uses the web-search setting
from the user's Codex configuration. Stereo's named Claude planner and reviewer agents allowlist
`WebFetch` and `WebSearch`, which are available only when the running harness provides them; an
inline `claude:session` role uses the harness's own tool grants. The Claude agent allowlists are
Stereo's static configuration, while actual tool availability and Codex web-search settings
remain platform- and user-owned.

### Deliberate boundaries

There are two deliberate boundaries. `/stereo:rescue` and `/stereo:transfer` remain Codex bridges.
`claude:session` is rejected for implementation so Claude writes stay contained in the
file-edit-only implementer agent.

| Surface                                                                | Codex route              | Claude route                                          | Why                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Pair role flags (`/stereo:plan`, `/stereo:implement`, `/stereo:quick`) | All four roles           | All four; the implementer excludes `claude:session`   | Claude writes stay in the contained implementer agent                                                               |
| `/stereo:tournament` contestants                                       | Two or three contestants | Named agents only; no `claude:session`                | Every contestant writes in an isolated worktree                                                                     |
| Tournament/implement implementation reviewer                           | Yes                      | Yes, including `claude:session`                       | Review routing stays independent of implementation routing                                                          |
| `/stereo:config` role defaults                                         | All four roles           | All four, with the same implementer containment       | Durable workspace intent is available for either route                                                              |
| `/stereo:adversarial-review --model`                                   | Foreground or background | Foreground only                                       | `--background` creates durable Codex jobs                                                                           |
| `/stereo:review --model`                                               | Built-in `review/start`  | Foreground-only standard structured review            | Codex's built-in reviewer has no Claude analogue, so Stereo supplies its own brief; `--background` stays Codex-only |
| `/stereo:rescue --model`                                               | Companion `task` runtime | Rejected; use Quick, Implement, or adversarial review | Rescue is a thin Codex bridge                                                                                       |
| `/stereo:transfer`                                                     | Fixed destination        | Source session only; no Claude destination            | Transfer is deliberately Claude → Codex                                                                             |
| `--effort` and `--*-effort`                                            | Runtime controls         | No control; choose a Claude model instead             | An all-Claude command-wide `--effort` is accepted and reported as inert                                             |
| `--background` and `/stereo:status`                                    | Durable jobs and status  | Session-bound agents; use foreground role routes      | There is no session-independent Claude execution surface                                                            |
| Stored-plan `model`/`effort`                                           | Last Codex pair values   | Not recorded; use `/stereo:config` workspace defaults | The Claude workspace default outranks the stored-plan model                                                         |

Implementation review defaults to a contained `claude:fable`, independent of the orchestrating
session that produced and fixed the work. The cheaper `claude:session` route remains available as
an explicit inline choice, but it is not independent. Containment is not cross-ecosystem
independence: under the defaults three of four roles are Claude-routed while `codex:sol` remains
the implementer. Use `--implementation-reviewer codex:sol` or `/stereo:adversarial-review` to buy
cross-ecosystem independence back at the implementation gate.

## Codex integration

Claudex Stereo wraps the [Codex app server](https://developers.openai.com/codex/app-server). It
uses the global `codex` binary installed in your environment and
[applies the same configuration](https://developers.openai.com/codex/config-basic).

### Write runs and thread safety

Write-capable runs verify the effective sandbox when resuming a thread. If a shared runtime
ignores the workspace-write escalation, the plugin retries once on a private runtime. After a
successful retry, a plugin-owned shared runtime is drained only when it is idle; busy or
externally owned runtimes are left alone and refresh through their normal lifecycle.

Every persisted Codex thread is reserved for one run at a time; the reservation errors you may
encounter and their remedies are listed under [Troubleshooting](#troubleshooting).

### Common configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Other model providers

Codex custom providers currently require `wire_api = "responses"`. A Chat Completions endpoint cannot be used directly: `wire_api = "chat"` is rejected by current Codex. Point `base_url` at an endpoint that actually speaks the Responses API, whether that is a provider-native endpoint or a gateway you operate.

The plugin does not endorse or verify any third-party endpoint or gateway. Its aliases only select a model id and a `[model_providers.<id>]` table per thread. Start from a provider stanza like this in `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`):

```toml
[model_providers.example]
name = "My Responses provider"
base_url = "https://responses-speaking.example/v1"
env_key = "EXAMPLE_API_KEY"
wire_api = "responses"
```

Use the provider id from the table below in place of `example`. The URLs in the last column document the model ids and API keys; they are not claims that the provider's native endpoint implements the Responses API.

| Alias            | Model id          | Provider table                | Conventional key    | Provider documentation                                                                       |
| ---------------- | ----------------- | ----------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `codex:kimi`     | `kimi-k3`         | `[model_providers.moonshot]`  | `MOONSHOT_API_KEY`  | [Kimi API](https://platform.kimi.ai/docs/overview)                                           |
| `codex:qwen`     | `qwen3.7-plus`    | `[model_providers.dashscope]` | `DASHSCOPE_API_KEY` | [Alibaba Cloud Model Studio](https://help.aliyun.com/en/model-studio/text-generation-model/) |
| `codex:deepseek` | `deepseek-v4-pro` | `[model_providers.deepseek]`  | `DEEPSEEK_API_KEY`  | [DeepSeek API](https://api-docs.deepseek.com/quick_start/pricing/)                           |
| `codex:glm`      | `glm-5.2`         | `[model_providers.zhipu]`     | `ZAI_API_KEY`       | [Z.AI API](https://docs.z.ai/guides/overview/migrate-to-glm-new)                             |

Aliases and their exact registered model ids select the listed provider per thread. For example, both `--model codex:kimi` and `--model codex:kimi-k3` route to `model_providers.moonshot`. An unregistered raw model id is passed through unchanged with no provider override, so it uses your config's default `model_provider`. These provider models are not Codex models—they execute through the Codex CLI runtime, which is what the `codex:` prefix names—and because the prefix is optional, `--model codex:kimi` and the bare `--model kimi` are the same request.

Before first use, save just the provider stanza to a temporary TOML file and run the compatibility probe from this repository checkout:

```bash
npm run provider-probe -- --config /path/to/provider-stanza.toml --model kimi-k3
npm run provider-probe -- --config /path/to/provider-stanza.toml --model kimi-k3 --live
```

The first command starts Codex with a temporary `CODEX_HOME` to prove the stanza parses; it does not edit your real config. `--live` additionally requires the stanza's `env_key`, makes a tool-using turn and a follow-up turn in a scratch workspace, and may incur provider charges. Re-run it when a provider changes its endpoint or model catalog.

Third-party structured-output and tool-calling fidelity varies. Run a small
`/stereo:plan --plan-reviewer <alias> ...` round before trusting a provider with implementation
work. Provider API-key billing and quotas are independent of ChatGPT plan quotas.

### Moving the work over to Codex

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed
inside Codex by running `codex resume` either with the specific session ID you received from
running `/stereo:result` or `/stereo:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## Troubleshooting

Run `/stereo:setup` first: its report covers Codex availability and authentication, the effective
write sandbox, provider environment keys, stranded thread reservations, and review-gate state.

**Thread reservation errors.** Every persisted Codex thread is reserved for one run at a time.
These are the reservation errors you may encounter:

- "already being used by another Codex run (job ...)" means the owner is still live. Wait for it,
  or cancel that job. Reservations are global to `CODEX_HOME`, while `/stereo:cancel` resolves
  jobs within the current workspace; cancel a conflicting job from another repository in its own
  workspace or session, or wait for it to finish.
- "appears to have crashed while reserving" means the owner is gone. Delete the exact lock file
  named in the error, then retry.
- "Reservation cleanup is already in progress" means cleanup may still be active. Wait; if it
  appears stuck, run `/stereo:setup` for the state-correct remedy. Do not delete both files
  blindly because the lock may already belong to a live successor.
- An unreadable reservation should be inspected before deleting the named invalid file.

`/stereo:setup` and `/stereo:status` list stranded reservations and their exact remedy paths.

**A write-capable run reported no file changes.** Check `/stereo:setup` and its write-sandbox
line before assuming the requested edits were possible. On Ubuntu 24.04, Codex write runs need
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`, which is not persisted across reboots.

**The harness does not expose `opus` or `fable`.** Named Claude model availability is a
default-path dependency in both the planning and implementation phases. Select
`--planner claude:session`, use `claude:inherit` for a contained role, select
`--plan-reviewer codex:sol`, or select `--implementation-reviewer claude:session`, `claude:inherit`, or
a Codex model. Stereo surfaces the original availability error and never silently substitutes a
model.

**`--background` is rejected with a `claude:*` model.** Claude agent reviews are session-bound
and never appear in `/stereo:status`; choose a Codex model for a durable background run
([Background jobs](#background-jobs)).

**`/stereo:transfer` fails on an older Codex.** The transfer needs Codex's external-agent session
importer; upgrade Codex first ([`/stereo:transfer`](#stereotransfer)).

**A custom provider is rejected with `wire_api = "chat"`.** Codex custom providers require a
Responses API endpoint; probe a stanza with `npm run provider-probe` before first use
([Other model providers](#other-model-providers)).

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here
too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to
Codex with either a ChatGPT account or an API key.
[Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/),
and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both
ChatGPT and API key sign-in. Run `/stereo:setup` to check whether Codex is ready, and use
`!codex login` if it is not.

If you use only a custom provider, its `model_providers` stanza and environment key can satisfy
runtime authentication instead; see [Other model providers](#other-model-providers).

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use my existing Codex config and API keys?

Yes. Because the plugin uses your local Codex CLI, it picks up the same
[configuration](#common-configurations), and your existing sign-in method and API key or base URL
setup still apply. If you need to point the built-in OpenAI provider at a different endpoint, set
`openai_base_url` in your
[Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Changelog and contributing

Release history lives in [plugins/stereo/CHANGELOG.md](plugins/stereo/CHANGELOG.md). Contributor
and development notes live in [CLAUDE.md](CLAUDE.md), with [AGENTS.md](AGENTS.md) as the
Codex-side entry point to the same guidance.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Claudex Stereo began as a fork of OpenAI's Codex
plugin for Claude Code (`openai/codex-plugin-cc`) and has been heavily extended since; upstream
attribution is retained in [NOTICE](NOTICE).
