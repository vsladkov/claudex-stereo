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
- [Model routing reference](#model-routing-reference) — families and versions, prefixes, effort, model choice
- [Codex integration](#codex-integration)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq) · [Changelog and contributing](#changelog-and-contributing) · [License](#license)

## What you get

- [`/stereo:review`](#stereoreview) for a normal read-only review routed to Codex or Claude
- [`/stereo:adversarial-review`](#stereoadversarial-review) for a steerable challenge review
- [`/stereo:plan`](#stereoplan) and [`/stereo:implement`](#stereoimplement) for a checkpointed
  pair workflow with an independent Claude or Codex model choice at every step
- [`/stereo:plan-state`](#stereoplan-state) to read any slot's reviewed plan before implementation
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
- [`/stereo:doctor`](#stereodoctor) to inspect workspace broker, durable state, worktrees, stalled
  jobs, and the announcement watermark

## Requirements

- **Codex authentication or a configured custom model provider.**
  - OpenAI-backed usage contributes to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Codex CLI 0.156.1 or later.** The default review gates run GPT-6 Astra (`codex:astra-6`),
  which older CLIs cannot configure, and Codex model families resolve through the app-server's
  model list. On an older CLI, pin the gates to a raw model id that CLI runs, for example
  `/stereo:config --plan-reviewer codex:gpt-5.6-sol --implementation-reviewer codex:gpt-5.6-sol`,
  or pass the role flags per run.
- **Node.js 24 or later** (the plugin runs its TypeScript sources natively via Node's type stripping)
- **Claude Code 2.1.281 or later, logged in, for Claude roles.** Named Claude selections
  (`claude:<family>[-<version>]`) run as headless `claude -p` sessions of the Claude Code CLI the
  plugin runs inside. The default planner (`claude:fable-5.1`) and implementer
  (`claude:opus-5.5`) are Claude roles and the default review gates (`codex:astra-6`) are Codex
  roles, so both runtimes must be ready for the defaults to work end to end. `/stereo:setup`
  checks the CLI's version and login; if either fails, use the
  [per-role model escape hatches](#troubleshooting).
- **On Linux, `sysctl kernel.apparmor_restrict_unprivileged_userns=0` for write sandboxes**
  (Ubuntu 24.04; not persisted across reboots). Codex write runs need it for their bubblewrap
  sandbox, and so does the optional Claude implementer sandbox that
  [`/stereo:config --claude-sandbox on`](#stereoconfig) enables.

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

`/stereo:setup` will tell you whether Codex and the Claude Code CLI are ready. If Codex is missing and npm is available, it can offer to install Codex for you.

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
- the `stereo:codex-rescue` subagent in `/agents`, the Codex bridge that `/stereo:rescue` launches

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
# Stereo Status

Session runtime: direct startup
Review gate: disabled

Latest finished:
- review-ms3bgmam-3bpyi8 | completed | review | Codex Review
  Model: gpt-6-astra
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

Every multi-role command uses role-named model flags—`--planner`, `--plan-reviewer`,
`--implementer`, and `--implementation-reviewer`—each with a matching effort flag
(`--planner-effort` and so on). Model selections use one addressing convention:

- `claude:session` runs the role inline in this conversation (planner and reviewer roles, never
  the implementer), with no effort, no job, and no background form.
- `claude:<family>[-<version>]`—families `opus`, `fable`, `sonnet`, and `haiku`—runs the role as a
  headless Claude Code session (`claude -p`) that the companion launches, tracks, and resumes as a
  background job, exactly like a Codex selection. A family alone means the newest version the
  plugin knows (`claude:opus` is Opus 5.5 today); `claude:opus-4.8` pins a version.
- Anything else is a Codex selection—a model family resolved against your account's Codex model
  catalog (`codex:sol` for the newest Sol, `codex:sol-5.6` for one version), a raw model id, a
  third-party alias, or a qualified `model@provider` id—written throughout this documentation with
  the optional `codex:` prefix.

Defaults with no role flags, shared by `/stereo:plan`, `/stereo:implement`, and `/stereo:quick`:

| Role                    | Built-in default (model and version) | Runs                           | Effort                    |
| ----------------------- | ------------------------------------ | ------------------------------ | ------------------------- |
| Planner                 | `claude:fable-5.1`                   | Fable 5.1 (`claude-fable-5-1`) | `xhigh` (version default) |
| Plan reviewer           | `codex:astra-6`                      | GPT-6 Astra (`gpt-6-astra`)    | `xhigh` (version default) |
| Implementer             | `claude:opus-5.5`                    | Opus 5.5 (`claude-opus-5-5`)   | `xhigh` (version default) |
| Implementation reviewer | `codex:astra-6`                      | GPT-6 Astra (`gpt-6-astra`)    | `xhigh` (version default) |

Each built-in default pins a version, so it moves only through a plugin release. Override a role per
run with its flags or per workspace with [`/stereo:config`](#stereoconfig). Families, versions, and
prefixes live in the [Model routing reference](#model-routing-reference), and its
[effort rules](#effort-rules) say how each role's effort is decided.

### `/stereo:review`

Runs a normal read-only implementation-quality review on your current work: Stereo's structured
review brief, on Codex or Claude, as a companion job. `--native` instead runs a Codex selection
through the same built-in reviewer as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to
> run it in the background; only the inline `claude:session` route has no background form.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--scope auto|working-tree|branch` to select the review target. `auto` (the default) reviews the
working tree when `git status --short --untracked-files=all` is non-empty; otherwise it reviews the
default-base branch diff. `--base <ref>` takes precedence over `--scope`. The `staged` and
`unstaged` scopes are rejected.

The command supports `--wait`, `--background`, `--model`, `--effort`, and trailing focus text on
both runtimes, against the same `review-output.schema.json` contract used by
[`/stereo:adversarial-review`](#stereoadversarial-review). Focus text is fenced as untrusted
steering and weighed without narrowing the standard review contract. Without `--model`, the review
runs the implementation reviewer's role default—the workspace's stored model
([`/stereo:config`](#stereoconfig)), else the built-in `codex:astra-6`—and without `--effort` it
follows the [effort rules](#effort-rules). `claude:session` applies the same brief inline, with no
job and no effort. `--native` has no effort or focus control and reviews only the working tree or
a base branch; it passes no effort and, without `--model`, no model, so Codex's own `config.toml`
defaults apply. A foreground review that outlasts the ten-minute tool limit keeps running as a
job, and the command relays its outcome through `/stereo:result` instead of starting another. Use
adversarial review for a challenge review.

`--pr <n>` is user-side sugar for reviewing a checked-out pull request. When the optional `gh` CLI
is installed and authenticated, Stereo resolves the PR's base and verifies that `HEAD` exactly
matches the PR head before reviewing, then reviews against the base's commit. It never checks out
or otherwise mutates the worktree; when the heads differ, run `gh pr checkout <n>` yourself.
Without `gh`, check out the PR branch and pass `--base <ref>` manually. `--pr` cannot be combined
with `--base` or `--scope`.

Examples:

```bash
/stereo:review
/stereo:review --base main
/stereo:review --pr 42
/stereo:review --background
/stereo:review --model claude:opus
/stereo:review --model claude:opus focus on rollback safety
/stereo:review --background --model claude:sonnet-5 --effort high focus on rollback safety
/stereo:review --native
```

This command is read-only and will not perform any changes. When run in the background you can
use [`/stereo:status`](#background-jobs) to check on the progress and
[`/stereo:cancel`](#background-jobs) to cancel the ongoing task.

### `/stereo:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different
approach would have been safer or simpler.

It uses the same review target selection, `--scope`/`--base` rules, and `--pr <n>` behavior as
`/stereo:review`, and the same flags—`--wait`, `--background`, `--model`, `--effort`, and trailing
focus text—but has no `--native` form. Codex and named Claude selections run as companion jobs in
the foreground or background; `claude:session` applies the same adversarial brief inline and
rejects `--effort`. Like `/stereo:review`, it runs as the implementation reviewer: without
`--model` it runs that role's default model, so it never falls back to Codex's `config.toml`
defaults.

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
/stereo:adversarial-review --background --model claude:fable-5.1 --effort max challenge the session's assumptions with fresh context
```

This command is read-only. It does not fix code.

### `/stereo:config`

Shows or changes this repository's durable model and effort defaults for the planner, plan
reviewer, implementer, and implementation reviewer. The model flags are `--planner`,
`--plan-reviewer`, `--implementer`, and `--implementation-reviewer`; append `-effort` to a role
flag to set its effort (rejected for `claude:session`, which takes none). Selections use the same
forms as the pair commands.

An explicit command flag wins over the stored workspace default, which wins over the built-in
default; the [effort rules](#effort-rules) say which runs a stored effort applies to.

The output lists each role's stored values and what a run without a role flag launches, then the
model versions each runtime knows, a family's other versions newest first:

```text
- implementer: claude:opus-4.8 (effort high) → claude-opus-4-8 (effort high)
- plan-reviewer: not set → gpt-6-astra (effort xhigh, built-in codex:astra-6)
- claude:opus → claude-opus-5-5 (effort xhigh; also 4.8 xhigh)
```

A change that would leave a role's stored entry invalid is refused before anything is stored. A
hand-edited entry that is invalid (a model the grammar refuses, an effort off its model's ladder or
on a version that takes none, such as Haiku) is reported, marked `[invalid]`, and ignored whole, so
the built-in runs instead. What only a launch can judge—a Codex selection the cached catalog cannot
resolve, or a Codex tier the catalog does not list for that model—is stored with a warning, and the
launch refuses it naming the default.

`--claude-sandbox on|off` stores a workspace default for the Claude implementer's Bash sandbox.
When it is on, a named Claude implementer—in `/stereo:implement`, `/stereo:quick`, and as a
tournament contestant—runs under Claude Code's own Bash sandbox, which confines shell writes to the
working directory: bubblewrap on Linux (the same
`kernel.apparmor_restrict_unprivileged_userns=0` requirement as Codex's write sandbox), seatbelt on
macOS, unavailable on Windows. It is off by default because the sandbox may block writes to the OS
temp directory that test runners need, and it never applies to a Codex selection.

```bash
/stereo:config
/stereo:config --implementer-effort high
/stereo:config --implementer claude:opus-4.8 --implementer-effort high
/stereo:config --planner codex:terra --planner-effort high
/stereo:config --implementation-reviewer claude:opus
/stereo:config --claude-sandbox on
/stereo:config --clear planner-effort
/stereo:config --clear roles
```

Defaults live in `~/.codex/companion-state/<workspace>/state.json`, outside the repository, and
survive plugin reinstalls. A custom `CODEX_HOME` relocates that durable state. Reading config in a
fresh workspace does not create state files.

### `/stereo:plan`

Starts the planning half of the pair workflow. The current Claude session remains the orchestrator,
while the plan drafter and adversarial reviewer can each be either Claude or Codex:

| Step        | Flag              | Claude execution                                    | Codex execution                 |
| ----------- | ----------------- | --------------------------------------------------- | ------------------------------- |
| Plan draft  | `--planner`       | Read-only headless session                          | Fresh read-only task            |
| Plan review | `--plan-reviewer` | Read-only headless session, resumed on later rounds | Persistent `plan-review` thread |

Both roles accept the full addressing convention from the
[Model routing primer](#model-routing-primer). `--planner-effort` and `--plan-reviewer-effort` set
the effort of their companion-routed role on that runtime's ladder; a role without a flag follows
the [effort rules](#effort-rules). A role effort flag is rejected when that role is
`claude:session` or excluded by `--draft-only`/`--review-only`.
`--slot <name>` selects the durable plan slot and defaults to `default`; names are lowercased and
may use letters, digits, hyphens, and underscores.

With no role flags, the [default](#model-routing-primer) planner drafts in a fresh session and the
default plan reviewer gates the plan from the other ecosystem; every parsed review round is stored
automatically. Claude revises the plan between rounds, rebuts findings it can disprove, and may
descope scope-expanding findings into `## Out of scope` as documented residuals. Reviews are judged
against the plan's own `## Goal` and `## Out of scope`. Later rounds resume the same reviewer
([reviewer continuation](#reviewer-continuation)).

The review loop is capped at 6 rounds by default (healthy reviews approve in 2-5); use
`--max-plan-rounds <n>` to change the cap. A task too large for one honest plan is refused
up front: the planner returns a single `SPLIT REQUIRED: <reason>` line, which is relayed as a
split proposal instead of being retried into an oversized draft. At the cap Claude offers to split
the plan rather than iterate forever.

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
/stereo:plan --plan-reviewer claude:fable add rate limiting to the public API
/stereo:plan --planner claude:haiku add a validation check
/stereo:plan --plan-reviewer claude:opus refactor the retry logic
/stereo:plan --max-plan-rounds 3 refactor the retry logic
/stereo:plan --plan-reviewer codex:terra --plan-reviewer-effort high migrate the config loader
/stereo:plan --plan-reviewer codex:sol-5.6 review against the previous Sol generation
/stereo:plan --planner codex:luna --planner-effort high --plan-reviewer codex:sol --plan-reviewer-effort max migrate the config loader
/stereo:plan --draft-only draft a migration plan
/stereo:plan --slot api-rate-limit add rate limiting to the public API
/stereo:plan --review-only --plan-reviewer claude:opus
/stereo:plan --review-only --plan-file ./approved-plan.md
```

Planning is read-only: nothing is implemented until you run [`/stereo:implement`](#stereoimplement).
A stored plan carries its verdict, findings, and reviewer, never a thread: a companion review's
thread or session stays with its job, where `/stereo:result` prints its resume command, and
implementation always starts fresh with the complete plan embedded.

### `/stereo:implement`

Implements the plan reviewed by [`/stereo:plan`](#stereoplan). The implementer and implementation
reviewer are independently selectable while the current Claude session keeps ownership of the
gates, verification, fix loop, and final report:

| Step                  | Flag                        | Claude execution                                                     | Codex execution      |
| --------------------- | --------------------------- | -------------------------------------------------------------------- | -------------------- |
| Implementation        | `--implementer`             | Headless session in `acceptEdits` mode, confined to the working tree | Workspace-write task |
| Implementation review | `--implementation-reviewer` | Read-only headless session                                           | Fresh read-only task |

The same Claude and Codex model values accepted by `/stereo:plan` work here, except
`claude:session` is not a valid implementer: Claude writes always run in the contained implementer
session. `--implementer-effort` and `--implementation-reviewer-effort` set their roles' effort on
either runtime; a role without a flag follows the [effort rules](#effort-rules), and a role effort
flag is rejected for `claude:session` or a mode that does not run that role.
`--slot <name>` selects the stored plan to implement and defaults to `default`. Resume takes its
slot from the durable implementation record, so `--slot` and `--resume` cannot be combined.

Use [`/stereo:plan-state`](#stereoplan-state) to read the complete stored plan, its review
metadata, open questions, and residual risks before starting implementation.

With no role flags, the [default](#model-routing-primer) implementer applies and verifies the plan's
changes and the default implementation reviewer gates every round from the other ecosystem. On
either runtime, the implementer starts fresh with the complete plan embedded, never in the plan
reviewer's thread or session, and resumes only its own for fix turns. The fix loop is capped at 4
rounds by default; use `--max-fix-rounds <n>` to change the cap. Every role is pinned to the exact
model id it resolved to before its first launch, so a newer version released mid-run never splits a
phase across two versions.

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
`$CODEX_HOME/companion-state/<workspace>/implement-state.json`, which records the baseline, the
implementer's launch settings, its thread and latest job, the completed review rounds and fix turns,
and the stored-plan fingerprint. Resume checks the recorded job first—it can wait for a
still-running worker or fetch a finished worker's report—then re-reads the current delta and reruns
host checks; historical results are never treated as current evidence. The recorded implementer's
model, grants, sandbox setting, and effort stay fixed, so a workspace default changed meanwhile
never alters a running phase; only a record without an effort resolves it again at each launch. When
the stored plan changed or `HEAD` moved, it asks before continuing; when the baseline vanished, it
stops as stale. A complete record offers to start fresh, clear the record, or stop, and a record
written by an earlier release cannot be resumed. The first resumed reviewer is always freshly and
fully briefed.

`--isolated` runs implementation in a throwaway detached worktree under the OS temporary directory,
confining the implementer's writes there while durable state, jobs, and the shared broker remain
keyed to the main workspace, so `/stereo:status` works as usual. The worktree links the dependency
directories the main tree already ignores (`node_modules`, `.venv`, `venv`, `vendor/bundle`), so
checks run natively inside it without changing the main tree's status. Those directories are links
into the main checkout and must not change: every implementer is told never to install into or
modify them. Review and host checks target the worktree, then Stereo creates a binary patch and asks
before handing it back with `git apply --3way`; it never creates a commit. Isolation is rejected
with `--review-only` and `--base`, while `--resume` follows the worktree recorded by the interrupted
phase. Use [`/stereo:tournament`](#stereotournament) for the multi-implementer form of the same
machinery.

**The Claude implementer** verifies its own work: alongside the plan's edits it builds the
repository, runs the unit tests and static checks that exercise its changes, and fixes the failures
its changes introduced before reporting—each command appears with its exit status in the report's
`Verification` section, and failures it cannot attribute to its edits are reported as suspected
pre-existing. The session runs in `acceptEdits` mode, which confines edits and filesystem commands
to the working directory, with grants for the common build and test runners (`node`, `npm`, `npx`,
`pnpm`, `yarn`, `python3`, `pytest`, `go`, `cargo`, `make`) plus the plan's own verification
commands. It never runs git mutations, network access, package installs, or code generation the
repository's gates do not already run, and a denied write fails the job with the paths named.
[`/stereo:config --claude-sandbox on`](#stereoconfig) adds Claude Code's own Bash sandbox. Before
edits, the command scans the plan for steps outside that scope—version bumps, package
installation, out-of-gate code generation, migrations, network access, or interactive
processes—and asks whether to switch to the `codex:astra-6` implementer, leave those steps for you,
or stop. The orchestrator never executes shell text requested by a model.

**Verification is staged.** A baseline gate snapshot taken before implementation attributes every
red gate, so pre-existing failures are never silently "fixed" into the delta, and a bounded gate-fix
pre-loop repairs newly-introduced failures before the review round. A Claude implementer's results
are trusted from the job's own records rather than its report: a gate counts as green when its
latest recorded run exited 0 after the implementer's last edit, so before review the orchestrator
re-runs only the cheap static checks plus any gate without such a run. A Codex implementer's
in-sandbox results stay advisory behind the full check battery. A named Claude implementation
reviewer is granted the plan's verification commands, each as one exact permission rule such as
`Bash(npm test)`, and no role is ever granted a network, install, or heavy-stage command. A command
such a rule cannot express (one with quotes, a pipe, or `&&`) is granted to no role and runs as a
host gate instead. A repository-declared heavy stage (integration or end-to-end suites) runs on the
host strictly after an accepted review, and a rejected review sends the delta back to the
implementer first. The commands' allowed tools carry the common runner families (npx, pnpm, yarn,
dotnet, cargo, go, make, python3, pytest, mvn, gradle), so gates run without permission prompts in
non-Node repositories.

Implementation-review rounds are stateless on both runtimes: every fix-loop round is a fresh,
fully briefed review. When the resolved implementer and implementation reviewer are the same model
and the reviewer came from the built-in default, the command substitutes `claude:fable-5.1` so a
delta is never gated by the model that produced it; an explicit or workspace-configured
self-review is honored but called out.

Examples:

```bash
/stereo:implement
/stereo:implement --implementer claude:sonnet
/stereo:implement --implementation-reviewer codex:terra
/stereo:implement --implementation-reviewer codex:sol
/stereo:implement --implementation-reviewer claude:session
/stereo:implement --implementer codex:sol --implementation-reviewer claude:opus --implementation-reviewer-effort high
/stereo:implement --implementer codex:luna --implementer-effort xhigh --implementation-reviewer codex:sol --implementation-reviewer-effort max
/stereo:implement --max-fix-rounds 3
/stereo:implement --implementer codex:astra
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
> usage limits quickly. Default planning, implementation, and fix rounds consume Claude usage,
> while plan review and implementation review consume Codex usage. Start from a clean
> worktree, use `--implementation-reviewer claude:session` for the cheaper inline path, bound the
> loops with
> `--max-plan-rounds`/`--max-fix-rounds` if you want a budget, and consider
> `/stereo:setup --disable-review-gate` during long pair sessions.

### `/stereo:plan-state`

Shows the complete plan in the selected durable slot, together with its verdict, review round,
update time, review findings, open questions, residual risks, and the `implementedAt` marker when
present. `--metadata` returns the same review state without the plan body—the cheap read when only
the verdict and lifecycle matter. The default slot is selected when `--slot` is absent, and
`/stereo:quick` defaults to it and accepts `--slot <name>` like the phase commands. The marker means
a full implementation phase finished with an accepted review; it does not mean the work was
committed or merged. Findings are rendered as a compact severity-and-title list.

```bash
/stereo:plan-state
/stereo:plan-state --list
/stereo:plan-state --compare rate-limit-opus rate-limit-fable
/stereo:plan-state --slot api-rate-limit
/stereo:plan-state --open
/stereo:plan-state --slot api-rate-limit --open
/stereo:plan-state --metadata
/stereo:plan-state --clear
/stereo:plan-state --mark-implemented
```

Without flags, the command only renders the default plan in the terminal. Use `--list` to inventory
all slots and see which one owns the current implementation record.

`--compare <slotA> <slotB>` renders both slots' review metadata side by side, followed by a
unified-style line diff of the two plan texts (or `Plan text: identical.`). It names both slots
itself, so it does not combine with `--slot` or another action, and both slots must hold a stored
plan. Oversized plans suppress the diff and point at `--open` for an external comparison.

Use `--slot <name>` to select a named slot for showing, opening, clearing, or marking it
implemented. `--open` refreshes `pair-plan.md` for the default slot or `pair-plan-<slot>.md` for a
named slot in the durable state directory, then opens it in VS Code through the `code` CLI. The
command always prints the exported path, so you can open the file manually when `code` is
unavailable.

`--clear` asks for confirmation and removes both artifacts for the selected slot. It removes the
single implementation record only when that record belongs to the cleared slot. `--mark-implemented`
is normally invoked automatically after a successful full `/stereo:implement` or `/stereo:quick`
phase; storing a new plan or review revision clears the marker.

The durable state directory is normally `~/.codex/companion-state/<workspace>/`, outside the
repository. A custom `CODEX_HOME` inside the repository places all durable companion state there
instead. If no reviewed plan is stored for the repository, the command directs you to run
`/stereo:plan` first.

### `/stereo:quick`

Runs the complete cycle—both phases end to end—in one command for a small, single-feature task. Each
of the four roles is independently routable, with the same role flags and the same
alternating-vendor [defaults](#model-routing-primer) as the phase commands, crossing ecosystems at
every handoff. The scope gate still runs inline in this session before any routed draft.

Quick deliberately has no `--resume`: an interrupted quick run restarts from the beginning. Use
`/stereo:plan` plus `/stereo:implement` for longer work that needs resumable implementation state.
If an isolated Quick run crashes, its worktree is stranded without a durable pointer; Quick prints
the path when it creates the worktree, and [`/stereo:doctor`](#stereodoctor) lists stranded entries
with exact removal commands.

Quick pauses after 2 plan-review rounds and 2 implementation fix rounds by default.
`--max-plan-rounds <n>` (maximum 6) and `--max-fix-rounds <n>` change those caps. At the plan cap
you can keep iterating, implement the reviewed but unapproved plan with its findings carried
forward, or stop. Choosing keep iterating continues automatically, with the same reviewer, up to
round 5; round 6 is an absolute safeguard and offers only implement anyway or stop. Approved plans
also carry their review findings forward as advisory context. Dirty worktrees and exhausted fix
rounds still produce explicit safety gates. If the task needs a plan longer than roughly 120 lines
or crosses multiple features or subsystems, the planner refuses with a single
`SPLIT REQUIRED: <reason>` line, and quick stops before review and directs you to
[`/stereo:plan`](#stereoplan).

`--slot <name>` selects the durable plan slot Quick stores into and defaults to `default`. Quick
warns about an existing plan in that slot but never asks, because a Quick run that stores a plan
always implements it. `--isolated` moves implementation, implementation review, and fixes into a
throwaway detached worktree using the same machinery as
[`/stereo:implement --isolated`](#stereoimplement), while the plan draft and plan review always run
against the main tree.

The implementer starts fresh with the complete plan embedded, builds and tests its changes like
the `/stereo:implement` implementer, and the recap names every effective role before writes begin.
Review verdicts, inline ones included, are stored before quick transitions or stops, so later
`/stereo:implement` gates remain accurate.

```bash
/stereo:quick fix the retry delay calculation
/stereo:quick --slot scratch fix the retry delay calculation
/stereo:quick --isolated --max-fix-rounds 1 fix a small bug
/stereo:quick --max-plan-rounds 3 add a validation check
/stereo:quick --planner claude:haiku --plan-reviewer codex:terra --plan-reviewer-effort high add a validation check
/stereo:quick --plan-reviewer claude:sonnet --implementation-reviewer claude:opus fix a small bug
/stereo:quick --plan-reviewer claude:fable fix a small bug
/stereo:quick --plan-reviewer codex:luna --plan-reviewer-effort xhigh --implementer codex:sol --implementer-effort high fix a small bug
```

The latest reviewed plan is stored normally, so an interrupted approved run can resume with
`/stereo:implement` for the default slot or `/stereo:implement --slot <name>` otherwise. Nothing is
committed or pushed.

### `/stereo:tournament`

Runs one already-approved stored plan through 2 or 3 independent implementers. With no
`--implementer` flags, the default lineup uses the workspace `implementer` model for `c1` when it is
valid and Codex-routed, otherwise `codex:astra-6`; `c2` is `claude:opus-5.5`. Each contestant's
effort follows the [effort rules](#effort-rules) as an implementer—`xhigh` for both defaults—and
a paired `--implementer-effort` overrides it. Each contestant starts in its own detached
temporary worktree at the same `HEAD`, so the main working tree stays untouched while contestants
run and their evidence is reviewed. Two contestants are the minimum for a comparison; three is the
cap because every extra contestant adds an implementation run and an independent review,
increasing cost, rate-limit pressure, and cleanup work. Use `/stereo:implement` when you want one implementer.

Contestants may be Codex selections or named Claude selections (`claude:<family>[-<version>]`);
`claude:session` is rejected because Claude writes stay in the contained implementer role. Every
contestant runs as a concurrent background job inside its own worktree, with a job id that
`/stereo:status` lists and `/stereo:cancel` can stop. `--implementer-effort` pairs positionally
with the `--implementer` flags. The one implementation reviewer resolves as the explicit flag,
then the workspace `implementationReviewer` default, then `claude:fable-5.1`, and gives each
contestant a fresh single-round review with no contestant or reviewer history carried into the
next one: a companion reviewer reviews contestants concurrently, an inline `claude:session`
reviewer one at a time. A review is marked self-review when the reviewer resolves to the
contestant's model.

Stereo then shows the models, diffstats, implementer reports, review verdicts, and usage side by
side. When exactly one contestant is acceptable, or when every acceptable contestant produced a
byte-identical delta, Stereo selects the winner automatically. When no patched path overlaps a
currently dirty path, `HEAD` has not moved, and Git's 3-way preflight succeeds, it also applies that
patch itself. When several acceptable contestants disagree or none is acceptable, Stereo shows the
comparison and asks which delta to hand back. Nothing is ever committed or pushed, and every losing
delta is still preserved as a patch file.

A Claude contestant builds and tests inside its own worktree like the `/stereo:implement`
implementer, so only plan steps outside that scope appear as deviations in its report; a failed
contestant is withdrawn with its worktree retained. Stereo runs no gate suite per contestant:
reviewers receive each contestant's self-reported checks labeled as contestant-reported. After any
successful `git apply --3way` hand-back, whether automatic or user-confirmed, the normal repository
gates—and, when they pass, the repository's heavy stage—run once in the main tree, and that
post-hand-back run is the real verdict.

Before removing any completed losing worktree, Stereo writes its binary delta to a patch file
outside every repository tree and prints that path, so a losing implementation remains recoverable.
Failed or cancelled contestants retain their worktrees so partial deltas are not destroyed, and the
tournament prints each one's removal command. A crash or closed session can also strand worktrees;
[`/stereo:doctor`](#stereodoctor) lists them with exact removal commands.

The tournament writes a durable tournament record beside the stored plan and can be re-entered with
`/stereo:tournament --resume`; it never writes the implementation record. Contestants on either
runtime resume from their durable jobs. A fully successful hand-back—an acceptable winner, a
successful apply, and every identifiable main-tree gate green, the heavy stage included—marks the
stored plan implemented. Clearing the stored plan does not clear the tournament record; use the
tournament-state clear action as an explicit reset. A complete run costs one concurrent write job
per contestant and one review per non-empty completed contestant, so check both providers' usage
limits before racing expensive models.

```bash
/stereo:tournament
/stereo:tournament --resume
/stereo:tournament --implementer codex:sol --implementer claude:opus
/stereo:tournament --implementer codex:sol --implementer codex:luna
/stereo:tournament --implementer codex:sol --implementer codex:sol --implementer-effort high --implementer-effort max
/stereo:tournament --implementer claude:opus-5.5 --implementer claude:fable --implementer-effort high --implementer-effort xhigh
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
falling back to the repository's latest only when no session id is known. Only an earlier rescue
thread is offered, never one a pair role or the stop-time review gate ran.

Examples:

```bash
/stereo:rescue investigate why the tests started failing
/stereo:rescue fix the failing test with the smallest safe patch
/stereo:rescue --resume apply the top fix from the last run
/stereo:rescue --model codex:luna --effort medium investigate the flaky integration test
/stereo:rescue --model codex:luna fix the issue quickly
/stereo:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `claude:*` models are rejected because rescue is a Codex bridge. For Claude-side work, use
  `/stereo:quick` or `/stereo:implement` with `--implementer claude:<family>`, or
  `/stereo:review` or `/stereo:adversarial-review` with `--model claude:<family>`.
- Codex families such as `codex:luna` and version pins such as `codex:sol-5.6` are explained under
  [Codex model families](#codex-model-families);
  third-party aliases are listed under [Other model providers](#other-model-providers)
- follow-up rescue requests can continue this session's latest Codex task

### `/stereo:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a
`codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to
continue that same context directly in Codex.

The direction is deliberate: `/stereo:transfer` moves a Claude Code session into a resumable Codex
thread and takes no `--model` because the destination runtime is fixed; Codex threads resume in
Codex rather than transferring back into Claude, so use `/stereo:review --model claude:<family>`,
`/stereo:adversarial-review --model claude:<family>`, or a Claude role route in `/stereo:plan`,
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

`--background` runs long companion work—a Codex turn or a headless Claude session for a named
`claude:*` selection—as a durable job scoped to this repository, so it survives turn boundaries
and can be checked from any later prompt. Both runtimes share one job protocol: the same job ids,
logs, status, results, cancellation, and resumable thread ids (a Codex thread or a Claude session
id). Only the inline `claude:session` route has no job: it runs in this conversation and never
appears in `/stereo:status`.

At SessionStart, Stereo reads only this durable local index and adds a short context note for
active jobs plus terminal jobs completed since the previous session. It is silent for untouched
or jobless workspaces, never reads job logs or contacts the broker, and cannot block session
startup. Active jobs may be repeated after resume, clear, compact, or fork; finished jobs are
watermarked and announced once in normal use.

**`/stereo:status`**—the flagless listing shows running and recent companion jobs for this
repository, filtered to the current session when a session ID is known; an explicit job ID looks
up any job in this repository regardless of session. `--all` lists every session's jobs in this
repository and lifts the eight-most-recent cap on finished jobs. `--wait` blocks on one job and
requires a job ID; `--timeout-ms <ms>` (`0` answers at once) and `--poll-interval-ms <ms>` (at
least 100) tune that wait. `--brief` with a job ID prints one line,
`<status> <phase> <elapsedSeconds>s`. `--verbose` adds log-file paths, timestamps, and longer
progress previews. Plan reviews, reviews, and adversarial reviews are listed by kind (`plan-review`,
`review`, `adversarial-review`); a task is labelled by the pair role it ran (`planner`,
`implementer`, or `implementation-reviewer`), the stop-time review gate's task by `stop-gate`, and
any other task, such as a rescue, by `rescue`.

Use `--workspace <path>` on `/stereo:status`, `/stereo:result`, or `/stereo:cancel` to target jobs
recorded against another repository root, such as the main workspace for a worktree-isolated
`/stereo:implement --isolated` or `/stereo:tournament` run.

**`/stereo:status --usage`**—sums per-job token usage from the retained local job index and groups
it by job kind and model, with rendered tables or `--json`. The index retains at most 50 jobs, so
this is a bounded window rather than all-time history. Without `--all`, usage is scoped to the
current session when a session ID is known; `--all` widens scope to every retained workspace
job. Only `tokenUsage.job` is summed. The cumulative `tokenUsage.thread` value is deliberately
excluded because resumed jobs can share a thread and would otherwise be counted repeatedly. These
totals are local job accounting, not Codex or Claude account usage or billing.

**`/stereo:result`**—shows the final stored output for a finished job, headed by its runtime
(`# Codex Review`, `# Claude Plan Review`, and so on). A run that ended with a non-zero status
renders a `Run failed: …` line, plus `Denied: …` when a Claude write was denied. Every result ends
with `Model:`—the exact id the job ran, `claude-opus-5-5` for a `claude:opus` request today and
`gpt-6-astra` for `codex:astra`—its token usage, `Cost:` for a Claude job, and, when available, the
session ID with a resume command: `Resume in Codex: codex resume <session-id>` or
`Resume in Claude: claude --resume <session-id>`. Add `--report` to print only the report.

**`/stereo:cancel`**—cancels an active background job on either runtime. The cancellation is
recorded before the job's processes are stopped, so a run that finishes afterwards never
overwrites it; a job that finished first is left untouched
(`Job <id> already finished (<status>); nothing to cancel.`). A process counts as stopped only
once it is confirmed gone; when the cancel cannot confirm that, it names each such process for you
to end yourself. Cancel and session end signal a recorded process only after verifying it is still
the one the job started (its start time and command line), so a reused process id is never
signalled. A run stopped by a signal releases its thread or session reservation as it exits; a
reservation whose owner died without doing so is taken over by the next run that needs it.

**Session end.** When a Claude Code session ends, the companion stops that session's running jobs in
every workspace it launched them in. Claude Code gives a session-end hook 1.5 seconds, so the hook
only starts that sweep as a process of its own, which finishes after the session has closed. Each
job is recorded as cancelled before it is stopped, so one that finished meanwhile keeps its result.
`/clear` and `/resume` end the session without touching its jobs, which stay visible to
`/stereo:status --all`. A shared broker is never killed: the sweep asks the broker of every
workspace the session used to shut down, and one busy with another session's turn stays. A job whose
worker process disappeared some other way
(a crash, an out-of-memory kill) shows the phase `stalled`, where `status <job-id> --wait` returns
at once; [`/stereo:doctor`](#stereodoctor) lists it, and `/stereo:cancel <job-id>` settles it.

**Inactivity budget.** A turn on either runtime is abandoned when it produces no event for
`STEREO_TURN_INACTIVITY_TIMEOUT_MS` milliseconds (default `1800000`, thirty minutes; `0` disables
it).

```bash
/stereo:status
/stereo:status --usage
/stereo:status --usage --all --json
/stereo:status task-abc123 --wait --timeout-ms 60000 --poll-interval-ms 1000
/stereo:status task-abc123 --brief
/stereo:status --all
/stereo:status task-abc123 --workspace /path/to/main-repository --json
/stereo:result task-abc123
/stereo:result task-abc123 --report
/stereo:cancel task-abc123
```

### `/stereo:setup`

Checks whether Codex is installed and authenticated, and whether the Claude Code CLI is new enough
and logged in for Claude roles.
If Codex is missing and npm is available, it can offer to install Codex for you.

The report opens with `# Stereo Setup` and a `Status:` line that reads `ready` or
`needs attention`; a missing, too-old (before 2.1.281), or logged-out Claude Code CLI turns it to
`needs attention`, because the built-in planner and implementer are Claude roles, while Codex roles
stay usable. The report covers:

- Node, npm, and Codex availability, Codex authentication, and the effective write sandbox
- the Claude Code CLI version and login for Claude roles, with the fix for a missing, too-old, or
  logged-out CLI in the next steps
- the active model provider, each configured provider's environment-key status, and per-alias
  readiness
- a `Models` listing: every Claude version the plugin knows and every Codex family the account's
  catalog lists (refreshed on every setup run), each with the id its alias resolves to and its
  default effort (`claude:opus → claude-opus-5-5 (effort xhigh; also 4.8 xhigh)`), plus a next step
  for any role default the catalog cannot run
- the session runtime, thread reservations it could neither read nor remove (the check removes
  what a dead run left behind), review-gate state, and configured role defaults
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
`stereo-worktrees` entries, tournament-resume state, and the SessionStart job-announcement
watermark.

It also lists stalled jobs—records still marked queued or running whose worker process is gone—
with `/stereo:cancel <job-id>` as the step that settles each one. The command is read-only unless
you explicitly reset the announcement watermark:

```bash
/stereo:doctor
/stereo:doctor --reset-job-announcements
```

Doctor prints exact paths and cleanup commands but does not settle jobs, remove worktrees, restart
brokers, or clear implementation records itself. An unreadable `state.json` is never overwritten:
the next state write moves it aside to `state.json.corrupt-<timestamp>` and names that copy on
stderr, so job records and role defaults can still be recovered from it.

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

**Plan together, then build behind a Codex gate**

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
/stereo:plan --draft-only --slot rate-limit-opus --planner claude:opus add rate limiting to the public API
/stereo:plan --draft-only --slot rate-limit-fable --planner claude:fable add rate limiting to the public API
/stereo:plan-state --list
/stereo:plan-state --compare rate-limit-opus rate-limit-fable
/stereo:plan-state --slot rate-limit-opus --open
/stereo:plan-state --slot rate-limit-fable --open
```

Run two independent `--draft-only` passes with different planners, then merge their discoveries at
the findings level and plan once, reviewing normally. `--compare` puts both slots' review metadata
and a line diff of the two plan texts in one output, so the differences are visible without an
external tool; `--open` remains for reading each plan in full side by side. Each draft stays in its
own durable slot, and each `--open` writes a separate `pair-plan-<slot>.md` export, so no manual
copy is needed between passes.

**Start something long-running**

```bash
/stereo:adversarial-review --background
/stereo:review --background --model claude:opus
/stereo:rescue --background investigate the flaky test
```

Then check in with:

```bash
/stereo:status
/stereo:result
```

## Model routing reference

### Choosing models per role

The [built-in defaults](#model-routing-primer) are dogfooded choices, not enforcement: every role
flag remains free-form, and `/stereo:config` replaces any default for one repository. Resolution is
explicit role flag > stored workspace role default > built-in default; the reviewer a stored plan
names never resolves the implementer.

| Situation                        | Change from the defaults                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Command-heavy or Codex-side work | `--implementer codex:astra-6`, which moves the implementation gate to `claude:fable-5.1` |
| Cheapest implementation gate     | `--implementation-reviewer claude:session`                                               |

For most work, use the defaults:

```bash
/stereo:plan add rate limiting to the public API
```

A fresh contained planner is unanchored by the session's earlier conclusions, and each gate
belongs to the other ecosystem: in head-to-head reviews of identical artifacts, cross-ecosystem
reviewers surfaced defects that same-family reviewers missed—and a wrongly approved plan or
delta costs more than an extra review round. The defaults therefore alternate vendors at every
handoff: Claude drafts, Codex challenges the plan, Claude builds in a contained build/test-capable
session, Codex gates the diff. The implementation gate is a review the orchestrating session must
not perform itself—the session produced the delta, wrote the fix instructions, and has every
reason to read its own work generously—and under the defaults it is also never the implementer's
own model family. Stored plan-review findings travel into every implementation-review brief—labeled
advisory on approved runs and binding on unapproved ones—so what a contained reviewer misses is
the argument around them, not the findings. A plan whose steps need commands outside the
implementer's build/test scope (version bumps, package installation, out-of-gate codegen,
migrations, network access, interactive processes) prompts a switch to a command-capable Codex
implementer (`codex:astra-6`), which starts a fresh thread with the plan embedded.

Each route prices the workflow differently:

| Route                                                                     | Budget                  | Cost profile                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The defaults                                                              | Split across ecosystems | Drafting and implementation run on the Claude budget as headless Claude sessions; both review gates run on the OpenAI budget, the plan gate as a resumable `plan-review` thread (deep, deliberate rounds—minutes of wall time with heavily cached input—that later rounds resume cheaply) and the implementation gate as a fresh read-only task per round. |
| `--plan-reviewer claude:fable` / `--implementation-reviewer claude:fable` | Claude only             | Keeps a phase's review on the Claude budget with faster rounds. Later plan-review rounds resume the reviewer's session ([reviewer continuation](#reviewer-continuation)); implementation-review rounds stay fresh on both runtimes.                                                                                                                        |
| `--implementation-reviewer claude:session`                                | Claude, inline          | The cheapest implementation gate, but not independent of the session that produced the work.                                                                                                                                                                                                                                                               |

One flag moves the plan gate back to Claude for a faster, single-budget loop; selecting the
inline planner as well keeps the whole plan phase in this session:

```bash
/stereo:plan --plan-reviewer claude:fable <task>
/stereo:plan --planner claude:session --plan-reviewer claude:fable <task>
```

Containment is not cross-ecosystem independence
([deliberate boundaries](#deliberate-boundaries)). If the Claude Code CLI is too old or logged out
for Claude roles, use the per-role escape hatches under [Troubleshooting](#troubleshooting).

### Prefix semantics

The prefix names the executing runtime, not the model vendor. `claude:` names the Claude runtime—a
headless Claude Code session—and is required, so those selections are distinguishable from the
open Codex passthrough. `codex:` names the Codex app-server and is optional in commands because the
Codex side cannot be enumerated and includes third-party providers; this documentation writes it
for symmetry. Stored state, status output, and reports carry the exact id a launch passed—
`Model: gpt-6-sol` is what `codex:sol` resolved to, and `Model: claude-opus-5-5` is what
`claude:opus` or `claude:opus-5.5` ran—never a third spelling and never a bare alias.

### Codex model families

A Codex selection names a model family; the companion resolves it to the newest version the
account's Codex model catalog lists, and `-<version>` pins one:

| Selection                       | Resolves to (catalog of 2026-09-24)    | Default effort |
| ------------------------------- | -------------------------------------- | -------------- |
| `codex:astra` / `codex:astra-6` | `gpt-6-astra`                          | `xhigh`        |
| `codex:sol` / `codex:sol-6`     | `gpt-6-sol`                            | `xhigh`        |
| `codex:sol-5.6`                 | `gpt-5.6-sol`                          | `xhigh`        |
| `codex:luna`                    | `gpt-6-luna` (`codex:luna-5.6` is 5.6) | `xhigh`        |
| `codex:terra`                   | `gpt-5.6-terra`                        | `xhigh`        |
| `codex:gpt-5.5`                 | `gpt-5.5` (raw id; retires 2026-10-14) | `xhigh`        |

A family alias follows the catalog: a family that gains a new version resolves to it
automatically (`codex:sol` moved from `gpt-5.6-sol` to `gpt-6-sol` when GPT-6 Sol appeared), so
new OpenAI models need no plugin release. Both review gates default to the pinned `codex:astra-6`,
so a new Astra generation reaches the defaults only through a plugin release. A family or version
the catalog does not list is refused before any job record, naming what the catalog does list; a
raw model id passes through unchanged, matched case-insensitively (`codex:GPT-6-Astra` runs as
`gpt-6-astra`). A word with a digit or punctuation that the catalog does not list as a family is a
raw id too (`codex:llama3`, `codex:mistral:7b` for a custom provider); only a plain word such as a
misspelled `codex:atsra` is refused as an unknown family.

A launch refreshes the catalog when the cached copy is older than ten minutes, and
`/stereo:setup` always refreshes it; it is cached at
`$CODEX_HOME/companion-state/codex-models.json`. Before the first fetch, a built-in snapshot that
lists only GPT-6 Astra stands in, so a launch whose fetch fails with nothing cached resolves only
`codex:astra` and refuses any other family word
(`Cannot resolve "<selection>": fetching the Codex model catalog failed (…) …`).

Third-party aliases (`codex:kimi`, `codex:qwen`, `codex:deepseek`, and `codex:glm`) omit the effort
default and are listed under [Other model providers](#other-model-providers).

### Claude model versions

A Claude selection names a family the plugin knows—`opus`, `fable`, `sonnet`, or `haiku`—and runs
it as a headless Claude session. There is no Claude model catalog, so the plugin ships a version
table with the versions it knows and each one's default effort; the family alone is an alias for
the newest version in that table, and `-<version>` pins one. The plugin always passes Claude Code
the exact id, never a bare alias:

| Version   | Selection                                    | Model argument     | Default effort |
| --------- | -------------------------------------------- | ------------------ | -------------- |
| Opus 5.5  | `claude:opus` (alias) or `claude:opus-5.5`   | `claude-opus-5-5`  | `xhigh`        |
| Opus 4.8  | `claude:opus-4.8`                            | `claude-opus-4-8`  | `xhigh`        |
| Fable 5.1 | `claude:fable` (alias) or `claude:fable-5.1` | `claude-fable-5-1` | `xhigh`        |
| Sonnet 5  | `claude:sonnet` (alias) or `claude:sonnet-5` | `claude-sonnet-5`  | `xhigh`        |
| Haiku 4.5 | `claude:haiku` (alias) or `claude:haiku-4.5` | `claude-haiku-4-5` | none           |

A pin may separate its version's segments with `.` or `-` (`claude:opus-5-5` is `claude:opus-5.5`).
A version the table does not know, a misspelled family, or any other text after `claude:` is
rejected before launch, naming the families or versions the plugin knows. Haiku takes no effort:
an effort flag on it, or a stored effort beside it, is rejected before any job record. A new Claude generation
reaches `claude:<family>` with the plugin release that adds it; the built-in planner and
implementer pin their versions and move only when a release changes them.

### Effort rules

Effort is resolved per role. The pair commands take the role flags `--planner-effort`,
`--plan-reviewer-effort`, `--implementer-effort`, and `--implementation-reviewer-effort`, and
`/stereo:review`, `/stereo:adversarial-review`, and `/stereo:rescue` take `--effort`; there is no
command-wide `--effort` on `/stereo:plan`, `/stereo:implement`, `/stereo:quick`, or
`/stereo:tournament`. For each companion-routed role, effort is decided in three steps:

1. The role effort flag, when given.
2. Otherwise the role default's effort, when the run uses that default's model and the default
   carries an effort. The default is the workspace's stored default when it names a model, else
   the built-in, which names no effort—an effort stored with `/stereo:config` without a model
   applies to the built-in model. Models compare by the id they resolve to, so
   `--implementer claude:opus` matches a `claude:opus-5.5` default while Opus 5.5 is the newest
   Opus, and `--implementer claude:opus-4.8` does not.
3. Otherwise the selected version's default effort: `xhigh` for every Claude version but Haiku 4.5,
   which takes none, and for a Codex version `xhigh`, or the highest tier below it that the
   catalog lists for that model. Third-party provider models take none.

A stored effort therefore follows its stored model: after
`/stereo:config --implementer claude:opus-4.8 --implementer-effort high`, the implementer runs Opus
4.8 at `high`, while a run with `--implementer claude:opus-5.5` runs Opus 5.5 at `xhigh`.
Everything defaults to `xhigh`; lower it per workspace or per run where you want faster, cheaper
turns. `/stereo:rescue` and the stop-time review gate run no role, so without `--effort` they use
Codex's own default.

Each runtime validates its own ladder. Codex accepts `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, and `ultra`; `ultra` is the tier above `max` on the models whose catalog entry lists
it (`/stereo:setup` shows each model's tiers), and no default reaches `max` or `ultra`. Claude
accepts `low`, `medium`, `high`, `xhigh`, and `max`. An explicit or stored effort the resolved
model does not take—a Haiku effort, or a Codex tier its catalog entry does not list—is refused
before any job record. A role effort flag is rejected for `claude:session`, which runs inline and
takes no effort, and Stereo never translates an effort into an inline-session control
(`ultrathink` is a main-turn keyword only).

### Reviewer continuation

Within one command run, later plan-review rounds resume the same reviewer: round 1 is always a
fresh, fully briefed reviewer, and later rounds send a compact round message instead of the full
brief. A Codex plan reviewer resumes its persistent `plan-review` thread and a named-Claude plan
reviewer its headless Claude session; an inline `claude:session` reviewer shares this conversation.
A malformed round is retried once on the same thread with the exact validation error named. A
reviewer's continuation never crosses command runs: a stored plan carries no thread, so a later
review starts a fresh reviewer. A thread or session is driven by one run at a time.

A thread or session belongs to the role that ran it: an implementer never continues a plan
reviewer's, and implementation-review rounds are stateless on both runtimes—each round is a fresh
read-only task that reviews a changed delta with full per-round independence, so there is no
approval context worth resuming.

### Role briefs and guidance files

Stereo uses one canonical brief per role, regardless of which ecosystem performs it:

| Role                    | Canonical brief                                   | Filled by                                                                      | Consumers                                        |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Planner                 | `plugins/stereo/prompts/plan-draft.md`            | Command, every route                                                           | Plan and Quick drafts, all routes                |
| Plan reviewer           | `plugins/stereo/prompts/plan-review.md`           | Companion (Claude or Codex); command for `claude:session`                      | Plan and Quick review rounds, all routes         |
| Reviewer                | `plugins/stereo/prompts/review.md`                | Companion (Claude or Codex); command for `claude:session`; `--native` skips it | `/stereo:review`                                 |
| Implementation reviewer | `plugins/stereo/prompts/implementation-review.md` | Command; runtime enforces the schema on companion routes                       | Implement and Quick review rounds, all routes    |
| Adversarial reviewer    | `plugins/stereo/prompts/adversarial-review.md`    | Companion (Claude or Codex); command for `claude:session`                      | Adversarial review, both ecosystems              |
| Implementer             | Equivalent prompt and containment contracts       | Command; the role definition is the session's system prompt                    | Implement and Quick implementation and fix turns |

On a named Claude route the companion also supplies the role's definition from the plugin's own
`roles/` directory as the headless session's system prompt, so a modified copy under
`.claude/agents/` never shadows it.

Codex reads repository-root `AGENTS.md` guidance, while Claude Code reads `CLAUDE.md`. A
single-file repository can keep `AGENTS.md` canonical and make `CLAUDE.md` import it with
`@AGENTS.md`. A two-file repository can instead point or mirror the applicable guidance in both;
this repository keeps `CLAUDE.md` canonical and a separate `AGENTS.md` with Codex-specific notes.

Live-source access follows each platform's own configuration. Codex uses the web-search setting
from the user's Codex configuration. Stereo's named Claude roles list only `Read`, `Glob`, `Grep`,
and `Bash` (plus `Edit` and `Write` for the implementer)—no web tools—and run under Claude Code's
permission rules without prompting: a call those rules do not allow is denied and reported with the
job's result. An inline `claude:session` role uses this session's own tool grants.

### Deliberate boundaries

There are two deliberate boundaries. `/stereo:rescue` and `/stereo:transfer` remain Codex bridges.
`claude:session` is rejected for implementation so Claude writes stay contained in the
implementer role—a headless session confined to the working tree, whose shell is scoped to
building and testing its own changes.

| Surface                                                                | Codex route                                          | Claude route                                                  | Why                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Pair role flags (`/stereo:plan`, `/stereo:implement`, `/stereo:quick`) | All four roles                                       | All four; the implementer excludes `claude:session`           | Claude writes stay in the contained implementer role                                    |
| `/stereo:tournament` contestants                                       | Two or three contestants                             | Named selections only; no `claude:session`                    | Every contestant writes in an isolated worktree                                         |
| Tournament/implement implementation reviewer                           | Yes                                                  | Yes, including `claude:session`                               | Review routing stays independent of implementation routing                              |
| `/stereo:config` role defaults                                         | All four roles                                       | All four, with the same implementer containment               | Durable workspace intent is available for either route                                  |
| `/stereo:review` and `/stereo:adversarial-review --model`              | Structured review job; `--native` for `review/start` | Structured review job; `claude:session` inline only           | The same brief on both runtimes; Codex's built-in reviewer is the opt-in                |
| `/stereo:rescue --model`                                               | Companion `task` runtime                             | Rejected; use Quick, Implement, review, or adversarial review | Rescue is a thin Codex bridge                                                           |
| `/stereo:transfer`                                                     | Fixed destination                                    | Source session only; no Claude destination                    | Transfer is deliberately Claude → Codex                                                 |
| `--*-effort` role flags and the single-role `--effort`                 | Runtime controls (`none`…`ultra`)                    | Runtime controls (`low`…`max`); none for `claude:session`     | Effort is per role; a role without a flag runs at its default's effort or its version's |
| `--background` and `/stereo:status`                                    | Durable jobs and status                              | Durable jobs and status; `claude:session` has no job          | One job protocol for both runtimes; only the inline route lives in this conversation    |

Implementation review defaults to `codex:astra-6`, independent of both the orchestrating session
and the Claude-routed default implementer that produced the work: under the defaults every
artifact is judged by the other ecosystem—Codex challenges the Claude plan, and Codex gates the
Claude-built delta. `--implementation-reviewer claude:fable` keeps that gate contained on the
Claude side instead, and the cheaper `claude:session` route remains an explicit inline choice,
though it is not independent of the session.

## Codex integration

Claudex Stereo wraps the [Codex app server](https://developers.openai.com/codex/app-server). It
uses the global `codex` binary installed in your environment and
[applies the same configuration](https://developers.openai.com/codex/config-basic).

### Write runs and thread safety

Write-capable runs verify the effective sandbox when resuming a thread. If a shared runtime
ignores the workspace-write escalation, the plugin retries once on a private runtime. After a
successful retry, a plugin-owned shared runtime is drained only when it is idle; busy or
externally owned runtimes are left alone and refresh through their normal lifecycle.

Every persisted Codex thread and every Claude session is reserved for one run at a time; the
reservation errors you may encounter and their remedies are listed under
[Troubleshooting](#troubleshooting).

When the shared workspace broker is busy with another session's turn, a run falls back to a private
runtime. A resume first waits, up to twelve seconds, while the broker finishes a turn that a dead
run left behind, so that turn's thread is never driven from two runtimes at once. A known
limitation: if a later turn on a thread the broker already holds runs on a private
runtime, a resume through the broker continues from its in-memory copy, which lacks that turn, until
the broker restarts (a session end stops it when it is idle).

### Common configurations

Codex's own `config.toml` model and reasoning-effort defaults reach only what a run leaves unset:
`/stereo:rescue` without `--model` or `--effort`, `/stereo:review --native` (which never passes an
effort, and passes a model only with `--model`), and the stop-time review gate. Every pair role and
every other `/stereo:review` or `/stereo:adversarial-review` passes an explicit model, so those
runs ignore `config.toml`.
To change the defaults for the runs that do read it, define them in your user-level or
project-level `config.toml`. For example to always use `gpt-5.6-luna` on `high` for a specific
project you can add the following to a `.codex/config.toml` file at the root of the directory you
started Claude in:

```toml
model = "gpt-5.6-luna"
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

Run `/stereo:setup` first: its report covers Codex availability and authentication, the Claude
Code CLI version and login, the effective write sandbox, provider environment keys, stranded
thread reservations, and review-gate state.

**Thread reservation errors.** Every persisted Codex thread and every Claude session is reserved
for one run at a time. These are the reservation errors you may encounter:

- "Thread or session ... is already being used by another companion run (job ...). Wait for it or
  cancel it first." means the owner is still live. Wait for it, or cancel that job. Reservations
  are global to `CODEX_HOME`, while `/stereo:cancel` resolves jobs within the current workspace:
  cancel a conflicting job from another repository with
  `/stereo:cancel <job-id> --workspace <that repository>`, or wait for it to finish.
- "Session or thread ... is busy or being reclaimed by another companion run; retry in a moment."
  is rare: the companion reclaims a reservation whose owner process is dead on the next run, so
  this message appears only when that reclaim raced another run. Retry once.
- "A previous companion run (job ..., pid ...) is gone, and the Claude process it started (pid ...)
  may still be running on thread or session .... Check that pid ... is that Claude process, end it
  if so (for example `kill <pid>`, or Task Manager on Windows), then retry." names a process the
  dead run may have left behind. The companion could not confirm that it is gone, so check what
  the pid runs before ending it.
- "Reservation cleanup is already in progress for thread or session ...." means another run is
  removing a dead run's reservation, which takes milliseconds. Retry; if it persists, run
  `/stereo:setup`, which removes what a dead run left behind and lists what it could not read or
  remove. Do not delete the files blindly, because the lock may already belong to a live successor.
- "The reservation for thread or session ... could not be read (...). Retry in a moment." means
  the file could not be opened just then, while its owner may still be running. Retry; this
  message never calls for a delete.
- "A thread or session reservation exists but could not be read. Delete <path> to release it, then
  retry." names the invalid lock file; inspect it before deleting it.

`/stereo:setup` and `/stereo:status` remove the reservations dead runs left behind and list only
what they could neither read nor remove, with the path to inspect.

**A write-capable run recorded no edit-tool file changes.** The run's file list (`touchedFiles`)
counts edit-tool writes only, so check `git status` first: a shell command may still have changed
files. Otherwise check `/stereo:setup` and its write-sandbox line before assuming the requested
edits were possible. On Ubuntu 24.04, Codex write runs need
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`, which is not persisted across reboots; a
Claude implementer running with `/stereo:config --claude-sandbox on` uses the same bubblewrap
sandbox and needs the same setting.

**Claude roles are unavailable: the Claude Code CLI is too old or logged out.** Named Claude
selections need Claude Code 2.1.281 or newer with an active login (or `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, or
`CLAUDE_CODE_USE_VERTEX` set, which `/stereo:setup` reports as the auth in use; an `apiKeyHelper`
in your user settings also reaches every role); the default planner and implementer depend on
them, so `/stereo:setup` reports `Status: needs attention` and names the fix, while Codex roles
stay usable. Until then, select `--planner claude:session`, a Codex implementer, and a Codex model
or `claude:session` for the reviewers. Stereo surfaces the original error and never silently
substitutes a model.

**A model selection is rejected.** A Claude pin must name a version the plugin knows
(`claude:opus-6` is refused, naming the versions it has); select the family alone for the newest.
A Codex family or version pin must be one the account's catalog lists; run `/stereo:setup` to see
them, or pass a raw model id, which is never checked against the family list. When no catalog has
been fetched and the fetch fails, only `codex:astra` resolves; fix the fetch (`/stereo:setup` names
the failure) or pass a raw model id. When the account's catalog lacks GPT-6 Astra, the built-in
review gates cannot run, and a model-less plan review, `/stereo:review`, or
`/stereo:adversarial-review` fails before any job record naming that default. Store gates the
catalog lists, for example
`/stereo:config --plan-reviewer codex:sol --implementation-reviewer codex:sol`.

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
