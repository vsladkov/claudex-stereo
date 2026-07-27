# Claudex Stereo

Claude and the Codex CLI as one signal: a Claude Code plugin that pairs the two models for planning, implementation, adversarial review, and delegated tasks.

> Based on OpenAI's Codex plugin for Claude Code (`openai/codex-plugin-cc`); see NOTICE for attribution. Heavily extended since: the dual-model pair workflow, shared broker runtime, background jobs, thread reservations, and review gates are additions of this fork.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

## What You Get

- `/stereo:review` for a normal read-only Codex review
- `/stereo:adversarial-review` for a steerable challenge review
- `/stereo:plan` and `/stereo:implement` for a checkpointed pair workflow with an independent Claude or Codex model choice at every step
- `/stereo:plan-state` to read the latest reviewed plan before implementation
- `/stereo:quick` for the same pair workflow in one command when the task is small
- `/stereo:rescue`, `/stereo:transfer`, `/stereo:status`, `/stereo:result`, and `/stereo:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **Codex authentication or a configured custom model provider.**
  - OpenAI-backed usage contributes to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 24 or later** (the plugin runs its TypeScript sources natively via Node's type stripping)

## Install

Add the marketplace in Claude Code:

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
- the `stereo:codex-rescue` and five mixed-model workflow helper subagents in `/agents`

One simple first run is:

```bash
/stereo:review --background
/stereo:status
/stereo:result
```

## Usage

### Workflow taxonomy

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
- `claude:inherit` runs the contained foreground agent with its invocation-level model parameter
  omitted. `CLAUDE_CODE_SUBAGENT_MODEL` wins when set; otherwise the agent inherits the main
  conversation's model.
- `claude:sonnet`, `claude:opus`, `claude:haiku`, and `claude:fable` use a contained foreground
  Claude agent.
- Any other value is a Codex model request or registry alias resolved by the companion.

`--effort` remains the command-wide Codex default. Multi-role commands also accept the matching
role flags: `--planner-effort`, `--plan-reviewer-effort`, `--implementer-effort`, and
`--implementation-reviewer-effort`. For each Codex-routed role, its role flag wins over
`--effort`, which wins over stored effort or the model-pair default. gpt-5.6-family selections
default to `max`, other `gpt-*` selections default to `xhigh`, and non-OpenAI selections omit an
effort override.

Stereo's Claude role agents intentionally omit the agent-definition `effort` field, so they
inherit the session's effort and extended-thinking configuration. Subagents have no separate
thinking setting, and `ultrathink` is a main-turn keyword only; Stereo never translates Codex
effort flags into prompt keywords. Claude agent definitions can set
`effort: low|medium|high|xhigh|max` (subject to model availability), but a modified copy under
`.claude/agents/` is only manually invocable: it cannot shadow the plugin-scoped `stereo:*` agents
the commands launch. Model selection is the available per-invocation Claude strength control.

Stereo uses one canonical brief per role, regardless of which ecosystem performs it:

| Role                    | Canonical brief                                   | Filled by                              | Consumers                                        |
| ----------------------- | ------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Planner                 | `plugins/stereo/prompts/plan-draft.md`            | Orchestrating command                  | Plan and Quick drafts, all routes                |
| Plan reviewer           | `plugins/stereo/prompts/plan-review.md`           | Runtime for Codex; command for Claude  | Plan and Quick review rounds, all routes         |
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

There are three deliberate boundaries. `/stereo:review` remains Codex-native; use
`/stereo:adversarial-review` for a Claude-routed review. `/stereo:rescue` and `/stereo:transfer`
remain Codex bridges. `claude:session` is rejected for implementation so Claude writes stay
contained in the file-edit-only implementer agent.

An inline `claude:session` review is convenient but not independent when the session produced the
work. Prefer a named Claude reviewer or Codex when you want genuinely fresh eyes.

### Choosing models per role

These are dogfooded defaults, not enforcement: every role flag remains free-form.

| Situation                              | Planner          | Plan reviewer    | Implementation reviewer |
| -------------------------------------- | ---------------- | ---------------- | ----------------------- |
| Routine work                           | `claude:session` | `sol`            | `claude:session`        |
| Infrastructure-critical or deep audits | `claude:opus`    | `claude:fable`   | `claude:session`        |
| Independent implementation gate        | Task-appropriate | Task-appropriate | Named Claude or Codex   |

For routine work, use the default `--planner claude:session` with the default
`--plan-reviewer sol`. This cross-ecosystem pairing keeps review independent, keeps the Claude and
OpenAI budgets separate, and leaves a resumable Codex plan-review thread. `/stereo:implement`
continues in the thread that approved the plan unless you pass `--fresh`.

```bash
/stereo:plan add rate limiting to the public API
```

For infrastructure-critical changes and periodic deep audits, use:

```bash
/stereo:plan --planner claude:opus --plan-reviewer claude:fable <task>
```

A fresh contained planner is not anchored on the session's earlier conclusions, and the strongest
model belongs at the approval gate because a wrongly approved plan costs more than an extra
revision round. The tradeoff is that a Claude-reviewed plan leaves no resumable Codex thread, so
implementation starts fresh with the complete plan embedded. Do not pair a `claude:*` role with
its role effort flag; the command rejects a role effort flag for a Claude-routed role.

Keep the implementation reviewer as `claude:session` by default. The session carries the whole
plan phase—revision history, rebuttals, descope rationale, and its own observations—into the
implementation gate. Stored plan-review findings also reach named reviewers through the review
brief; the session uniquely carries the rest of that context. When independence matters, switch
to a named reviewer such as `--implementation-reviewer claude:opus` or a Codex model, or run
`/stereo:adversarial-review` on the result. This matters above all when the orchestrating session
edited code itself; the [independence note above](#workflow-taxonomy) still applies.

For rare full-discovery sweeps, run two independent `--draft-only` passes with different planners,
compare and merge their discoveries at the findings level, then plan once and review normally.
Durable state holds exactly one stored plan per repository in `pair-plan.json`, so the second
`/stereo:plan --draft-only` overwrites the first. After the first pass, export it with
`/stereo:plan-state --open`; that command writes and prints `<state dir>/pair-plan.md`. Copy that
file somewhere outside the repository before the second draft because the next `--open` overwrites
it too.

### `/stereo:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait`, `--background`, and a Codex
`--model`. It is not steerable and does not take custom focus text. Claude model selections are
rejected because this command maps to Codex's built-in reviewer; use
[`/stereo:adversarial-review`](#stereoadversarial-review) for a Claude-routed challenge review.

Examples:

```bash
/stereo:review
/stereo:review --base main
/stereo:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/stereo:status`](#stereostatus) to check on the progress and [`/stereo:cancel`](#stereocancel) to cancel the ongoing task.

### `/stereo:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/stereo:review`, including `--base <ref>` for branch review.
It also supports `--wait`, `--background`, and `--model`. Unlike `/stereo:review`, it can take
extra focus text after the flags. Codex models can run in the foreground or background. All Claude
selections, including `claude:session` and `claude:inherit`, use the same adversarial brief and
structured output contract in the foreground. `--background --model claude:*` is rejected because
Claude agent reviews are session-bound and not visible in `/stereo:status`; choose a Codex model
for a durable background review.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/stereo:adversarial-review
/stereo:adversarial-review --base main challenge whether this was the right caching and retry design
/stereo:adversarial-review --background look for race conditions and question the chosen approach
/stereo:adversarial-review --model claude:opus challenge the rollback design
/stereo:adversarial-review --model claude:inherit challenge the session's assumptions with fresh context
```

This command is read-only. It does not fix code.

### `/stereo:plan`

Starts the planning half of the pair workflow. The current Claude session remains the orchestrator,
while the plan drafter and adversarial reviewer can each be either Claude or Codex:

| Step        | Flag              | Default                | Claude execution                       | Codex execution                 |
| ----------- | ----------------- | ---------------------- | -------------------------------------- | ------------------------------- |
| Plan draft  | `--planner`       | Current Claude session | Foreground read-only planner subagent  | Fresh read-only task            |
| Plan review | `--plan-reviewer` | `sol` at `max`         | Foreground read-only reviewer subagent | Persistent `plan-review` thread |

Claude model values are `claude:inherit`, `claude:sonnet`, `claude:opus`, `claude:haiku`, and
`claude:fable`; `claude:session` selects inline work by the current session. As described above,
`claude:inherit` honors `CLAUDE_CODE_SUBAGENT_MODEL` before inheriting the session model. Codex
values include registry aliases such as `sol`, `spark`, `terra`, and `luna`, raw model ids, and
qualified `model@provider` ids.

`--planner-effort` and `--plan-reviewer-effort` set effort for their Codex-routed role.
`--effort` is the fallback for either role when its specific flag is absent. A role effort flag is
rejected when that role is Claude-routed or excluded by `--draft-only`/`--review-only`.

With no new flags, Claude drafts inline and `sol` reviews at `max`, exactly as before. Claude
revises the plan between rounds, rebuts findings it can disprove, and may descope scope-expanding
findings into `## Out of scope` as documented residuals. Reviews are judged against the plan's own
`## Goal` and `## Out of scope`.

Named-Claude plan reviewers keep the same agent context across later rounds when the running
Claude Code harness supports follow-ups. Unsupported or malformed continuations fall back to the
fully re-briefed stateless review used previously. Implementation-review rounds remain stateless.

The review loop is capped at 6 rounds by default (healthy reviews approve in 2-5); use
`--max-plan-rounds <n>` to change the cap. At the cap Claude offers to split the plan rather than
iterate forever. gpt-5.6-family Codex selections default to `max`, other `gpt-*` models default to
`xhigh`, and non-OpenAI models omit the effort override.

Use `--draft-only` to run and store just the draft step. The stored plan has verdict `draft` and
review round 0, so implementation still presents the unapproved-plan gate. Use `--review-only` to
load the stored plan, run one fresh review round, persist its actual verdict, and stop without
revising it. The two modes conflict; each also rejects flags for a role or loop it does not run.

`terra` and `luna` map to `gpt-5.6-terra` and `gpt-5.6-luna`.

Examples:

```bash
/stereo:plan add rate limiting to the public API
/stereo:plan --planner claude:haiku add a validation check
/stereo:plan --plan-reviewer claude:opus refactor the retry logic
/stereo:plan --max-plan-rounds 3 refactor the retry logic
/stereo:plan --plan-reviewer terra --effort high migrate the config loader
/stereo:plan --planner spark --planner-effort high --plan-reviewer sol --plan-reviewer-effort max migrate the config loader
/stereo:plan --draft-only draft a migration plan
/stereo:plan --review-only --plan-reviewer claude:opus
```

Planning is read-only: nothing is implemented until you run
[`/stereo:implement`](#stereoimplement). Codex-reviewed plans retain their review thread.
Claude-reviewed plans are stored in the same durable state without a Codex thread, so later
implementation starts fresh with the complete plan embedded.

### `/stereo:implement`

Implements the plan reviewed by [`/stereo:plan`](#stereoplan). The implementer and implementation
reviewer are independently selectable while the current Claude session keeps ownership of the
gates, verification, fix loop, and final report:

| Step                  | Flag                        | Default                | Claude execution                      | Codex execution      |
| --------------------- | --------------------------- | ---------------------- | ------------------------------------- | -------------------- |
| Implementation        | `--implementer`             | Stored model or `sol`  | Foreground file-edit-only implementer | Workspace-write task |
| Implementation review | `--implementation-reviewer` | Current Claude session | Foreground read-only reviewer         | Fresh read-only task |

The same Claude and Codex model values accepted by `/stereo:plan` work here, except
`claude:session` is not a valid implementer: Claude writes are always isolated in the contained
file-edit agent. `--implementer-effort` and `--implementation-reviewer-effort` override their
respective Codex roles; `--effort` remains the fallback for either. A role effort flag is rejected
for a Claude-routed role or a mode that does not run that role.

Use [`/stereo:plan-state`](#stereoplan-state) to read the complete stored plan, its review metadata, open questions, and residual risks before starting implementation.

With no new flags, Codex implements with the stored model in the stored review thread when one
exists, and Claude reviews inline exactly as before. The fix loop is capped at 4 rounds by default;
use `--max-fix-rounds <n>` to change the cap, and `--fresh` to start a new Codex thread instead of
resuming the stored one. A Claude-reviewed plan also starts a fresh Codex thread with a truthful
outside-thread preamble.

Stored plan-review findings travel with the plan into implementation and implementation review:
they are binding known findings on an unapproved run and advisory context on an approved one.

Use `--implement-only` to run preflight, implementation, and host-side checks, then stop before
review. Use `--review-only` to treat the current dirty and untracked worktree as the complete
implementation delta, run one implementation-review step, and stop without applying fixes. A
clean worktree has nothing to review.

Codex implementation-review tasks pass the shipped implementation-review schema to the runtime,
so their final messages are schema-constrained before the command performs its normal validation
and retry checks. Claude routes retain command-side validation.

Claude implementation is deliberately file-edits-only: the agent has no shell, network, process,
or git tool. Before edits, the command detects plan steps requiring version scripts, package
installation, code generation, migrations, or interactive processes and asks whether to switch to
Codex, leave those command steps for you, or stop. It never executes shell text requested by a
model.

Examples:

```bash
/stereo:implement
/stereo:implement --implementer claude:sonnet
/stereo:implement --implementation-reviewer terra
/stereo:implement --implementer sol --implementation-reviewer claude:opus --effort high
/stereo:implement --implementer spark --implementer-effort xhigh --implementation-reviewer sol --implementation-reviewer-effort max
/stereo:implement --max-fix-rounds 3
/stereo:implement --fresh
/stereo:implement --implement-only
/stereo:implement --review-only --implementation-reviewer claude:opus
```

The final report lists the stored `residualRisks`, verification results, selected models, and any
user-owned command steps. Nothing is committed; you review and commit the result yourself.

> [!WARNING]
> The pair workflow runs multiple Codex calls at `max` effort and iterates until accepted by default, which can take a long time and consume usage limits quickly. Start from a clean worktree, bound the loops with `--max-plan-rounds`/`--max-fix-rounds` if you want a budget, and consider `/stereo:setup --disable-review-gate` during long pair sessions.

### `/stereo:plan-state`

Shows the complete plan most recently stored by `/stereo:plan` or `/stereo:quick`, together with
its verdict, review round, model and Codex thread, update time, review findings, open questions,
and residual risks. Findings are rendered as a compact severity-and-title list;
`/stereo:plan-state --json` returns their complete stored objects.

```bash
/stereo:plan-state
/stereo:plan-state --open
```

Without flags, the command only renders the stored plan in the terminal. Use `--open` to refresh a `pair-plan.md` snapshot in the durable state directory and open it in VS Code through the `code` CLI. The command always prints the exported path, so you can open the file manually when `code` is unavailable.

The durable state directory is normally `~/.codex/companion-state/<workspace>/`, outside the repository. A custom `CODEX_HOME` inside the repository places all durable companion state there instead. If no reviewed plan is stored for the repository, the command directs you to run `/stereo:plan` first.

### `/stereo:quick`

Runs the complete pair workflow in one command for a small, single-feature task. Each of the four
roles is independently routable. Defaults preserve the original cycle: the current Claude session
drafts, `sol` reviews at `max`, Codex implements with the resolved plan-review model and effort,
and the current Claude session reviews the implementation.

Quick automatically pauses after 2 plan-review rounds and 2 implementation fix rounds. At the
plan cap you can keep iterating in the same Codex thread, implement the reviewed but unapproved
plan with its findings carried forward, or stop; approved plans also carry their review findings
forward as advisory context. Dirty worktrees and exhausted fix rounds still produce explicit
safety gates. If the task needs a plan longer than roughly 120 lines or crosses multiple features
or subsystems, quick stops before review and directs you to
[`/stereo:plan`](#stereoplan).

Use the same four role flags as the phase commands:

| Role                    | Model flag                  | Effort flag                        | Default                                   |
| ----------------------- | --------------------------- | ---------------------------------- | ----------------------------------------- |
| Planner                 | `--planner`                 | `--planner-effort`                 | `claude:session`                          |
| Plan reviewer           | `--plan-reviewer`           | `--plan-reviewer-effort`           | `sol`                                     |
| Implementer             | `--implementer`             | `--implementer-effort`             | Latest Codex plan-review model and effort |
| Implementation reviewer | `--implementation-reviewer` | `--implementation-reviewer-effort` | `claude:session`                          |

When a Claude plan reviewer leaves no Codex thread to resume, quick starts a fresh Codex
implementation task. Its implementer default is `sol` with `--implementer-effort`, then
command-wide `--effort`, then `max`, and the recap names that effective choice before writes
begin. For every Codex role, the matching role effort flag overrides `--effort`. Claude review
verdicts are stored before quick transitions or stops, so later `/stereo:implement` gates remain
accurate.

```bash
/stereo:quick fix the retry delay calculation
/stereo:quick --planner claude:haiku --plan-reviewer terra --effort high add a validation check
/stereo:quick --plan-reviewer claude:sonnet --implementation-reviewer claude:opus fix a small bug
/stereo:quick --plan-reviewer spark --plan-reviewer-effort xhigh --implementer sol --implementer-effort high fix a small bug
```

The latest reviewed plan is stored normally, so an interrupted approved run can resume with `/stereo:implement`. Nothing is committed or pushed.

### `/stereo:rescue`

Hands a task to Codex through the `stereo:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/stereo:rescue investigate why the tests started failing
/stereo:rescue fix the failing test with the smallest safe patch
/stereo:rescue --resume apply the top fix from the last run
/stereo:rescue --model spark --effort medium investigate the flaky integration test
/stereo:rescue --model spark fix the issue quickly
/stereo:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `spark` maps to `gpt-5.3-codex-spark`; third-party aliases are listed under [Other model providers](#other-model-providers)
- follow-up rescue requests can continue the latest Codex task in the repo

### `/stereo:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/stereo:transfer
/stereo:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/stereo:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/stereo:status
/stereo:status task-abc123
/stereo:status --verbose
```

Verbose output adds log-file paths, timestamps, and longer progress previews.

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/stereo:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/stereo:result
/stereo:result task-abc123
```

### `/stereo:cancel`

Cancels an active background Codex job.

Examples:

```bash
/stereo:cancel
/stereo:cancel task-abc123
```

### `/stereo:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/stereo:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/stereo:setup --enable-review-gate
/stereo:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/stereo:review
```

### Hand A Problem To Codex

```bash
/stereo:rescue investigate why the build is failing in CI
```

### Small Fix, One Command

```bash
/stereo:quick fix the retry delay calculation
```

### Plan Together, Then Let Codex Build

```bash
/stereo:plan add rate limiting to the public API
/stereo:implement
```

### Run Every Step By Hand

```bash
/stereo:plan --draft-only add rate limiting to the public API
/stereo:plan --review-only
/stereo:implement --implement-only
/stereo:implement --review-only
```

If the one-round plan review returns `needs-revision`, ask the current session to revise and
re-store the plan before reviewing it again, or run the full `/stereo:plan` phase to use its
automated revision loop.

### Start Something Long-Running

```bash
/stereo:adversarial-review --background
/stereo:rescue --background investigate the flaky test
```

Then check in with:

```bash
/stereo:status
/stereo:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Write runs and thread safety

Write-capable runs verify the effective sandbox when resuming a thread. If a shared runtime ignores the workspace-write escalation, the plugin retries once on a private runtime. After a successful retry, a plugin-owned shared runtime is drained only when it is idle; busy or externally owned runtimes are left alone and refresh through their normal lifecycle.

Every persisted Codex thread is reserved for one run at a time. These are the reservation errors you may encounter:

- "already being used by another Codex run (job ...)" means the owner is still live. Wait for it, or cancel that job. Reservations are global to `CODEX_HOME`, while `/stereo:cancel` resolves jobs within the current workspace; cancel a conflicting job from another repository in its own workspace or session, or wait for it to finish.
- "appears to have crashed while reserving" means the owner is gone. Delete the exact lock file named in the error, then retry.
- "Reservation cleanup is already in progress" means cleanup may still be active. Wait; if it appears stuck, run `/stereo:setup` for the state-correct remedy. Do not delete both files blindly because the lock may already belong to a live successor.
- An unreadable reservation should be inspected before deleting the named invalid file.

`/stereo:setup` and `/stereo:status` list stranded reservations and their exact remedy paths. If a result says "this write-capable run reported no file changes," check `/stereo:setup` and its write-sandbox line before assuming the requested edits were possible.

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.3-codex-spark` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.3-codex-spark"
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

| Alias      | Model id          | Provider table                | Conventional key    | Provider documentation                                                                       |
| ---------- | ----------------- | ----------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `kimi`     | `kimi-k3`         | `[model_providers.moonshot]`  | `MOONSHOT_API_KEY`  | [Kimi API](https://platform.kimi.ai/docs/overview)                                           |
| `qwen`     | `qwen3.7-plus`    | `[model_providers.dashscope]` | `DASHSCOPE_API_KEY` | [Alibaba Cloud Model Studio](https://help.aliyun.com/en/model-studio/text-generation-model/) |
| `deepseek` | `deepseek-v4-pro` | `[model_providers.deepseek]`  | `DEEPSEEK_API_KEY`  | [DeepSeek API](https://api-docs.deepseek.com/quick_start/pricing/)                           |
| `glm`      | `glm-5.1`         | `[model_providers.zhipu]`     | `ZAI_API_KEY`       | [Z.AI API](https://docs.z.ai/guides/overview/migrate-to-glm-new)                             |

Aliases and their exact registered model ids select the listed provider per thread. For example, both `--model kimi` and `--model kimi-k3` route to `model_providers.moonshot`. An unregistered raw model id is passed through unchanged with no provider override, so it uses your config's default `model_provider`.

Before first use, save just the provider stanza to a temporary TOML file and run the compatibility probe from this repository checkout:

```bash
npm run provider-probe -- --config /path/to/provider-stanza.toml --model kimi-k3
npm run provider-probe -- --config /path/to/provider-stanza.toml --model kimi-k3 --live
```

The first command starts Codex with a temporary `CODEX_HOME` to prove the stanza parses; it does not edit your real config. `--live` additionally requires the stanza's `env_key`, makes a tool-using turn and a follow-up turn in a scratch workspace, and may incur provider charges. Re-run it when a provider changes its endpoint or model catalog.

Third-party structured-output and tool-calling fidelity varies. Run a small
`/stereo:plan --plan-reviewer <alias> ...` round before trusting a provider with implementation
work. Provider API-key billing and quotas are independent of ChatGPT plan quotas.

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/stereo:result` or `/stereo:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/stereo:setup` to check whether Codex is ready, and use `!codex login` if it is not.

If you use only a custom provider, its `model_providers` stanza and environment key can satisfy runtime authentication instead; see [Other model providers](#other-model-providers).

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
