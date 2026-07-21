# Claudex Stereo

Claude and the Codex CLI as one signal: a Claude Code plugin that pairs the two models for planning, implementation, adversarial review, and delegated tasks.

> Based on OpenAI's Codex plugin for Claude Code (`openai/codex-plugin-cc`); see NOTICE for attribution. Heavily extended since: the dual-model pair workflow, shared broker runtime, background jobs, thread reservations, and review gates are additions of this fork.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/stereo:review` for a normal read-only Codex review
- `/stereo:adversarial-review` for a steerable challenge review
- `/stereo:plan` and `/stereo:implement` for a dual-model pair workflow: Claude plans and reviews, Codex critiques the plan and writes the code
- `/stereo:rescue`, `/stereo:transfer`, `/stereo:status`, `/stereo:result`, and `/stereo:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

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
- the `stereo:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/stereo:review --background
/stereo:status
/stereo:result
```

## Usage

### `/stereo:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/stereo:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/stereo:review
/stereo:review --base main
/stereo:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/stereo:status`](#codexstatus) to check on the progress and [`/stereo:cancel`](#codexcancel) to cancel the ongoing task.

### `/stereo:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/stereo:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/stereo:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/stereo:adversarial-review
/stereo:adversarial-review --base main challenge whether this was the right caching and retry design
/stereo:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/stereo:plan`

Starts the dual-model pair workflow: Claude drafts an implementation plan, then Codex adversarially reviews it in a persistent thread until it returns an `approve` verdict. Claude revises the plan between rounds, rebuts findings it can disprove, and may descope a finding into `## Out of scope` as a documented residual when fixing it would grow the plan beyond its goal - so the loop converges on a reviewable plan instead of accreting scope. Reviews are judged against the plan's own `## Goal` and `## Out of scope` sections; real but out-of-scope hazards come back as non-blocking `residual_risks` with follow-up-plan suggestions.

By default the plan reviews run with the `sol` model alias (mapped to `gpt-5.6-sol`) at `max` reasoning effort. gpt-5.6-family model overrides also default to `max`; other models default to `xhigh`. Override either with `--model` and `--effort`. The loop is capped at 6 rounds by default (healthy reviews approve in 2-5); use `--max-plan-rounds <n>` to change the cap, and at the cap Claude offers to split the plan rather than iterate forever.

`terra` and `luna` map to `gpt-5.6-terra` and `gpt-5.6-luna`.

Examples:

```bash
/stereo:plan add rate limiting to the public API
/stereo:plan --max-plan-rounds 3 refactor the retry logic
/stereo:plan --model gpt-5.4 --effort high migrate the config loader
```

Planning is read-only: nothing is implemented until you run [`/stereo:implement`](#codeximplement). The latest reviewed plan and its Codex thread are stored per repository.

### `/stereo:implement`

Implements the plan approved by [`/stereo:plan`](#codexplan). Codex writes the code in the same Codex thread that reviewed the plan (workspace-write sandbox), then Claude reviews the diff, runs the tests it can find, and sends numbered fix lists back to Codex until the implementation is accepted.

The fix loop is capped at 4 rounds by default; use `--max-fix-rounds <n>` to change the cap, and `--fresh` to start a new Codex thread instead of resuming the stored one. The final report lists the plan's stored `residualRisks` (documented non-blocking hazards with suggested follow-up plans). Nothing is committed; you review and commit the result yourself.

Examples:

```bash
/stereo:implement
/stereo:implement --max-fix-rounds 3
/stereo:implement --fresh
```

> [!WARNING]
> The pair workflow runs multiple Codex calls at `max` effort and iterates until accepted by default, which can take a long time and consume usage limits quickly. Start from a clean worktree, bound the loops with `--max-plan-rounds`/`--max-fix-rounds` if you want a budget, and consider `/stereo:setup --disable-review-gate` during long pair sessions.

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
/stereo:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/stereo:rescue --model spark fix the issue quickly
/stereo:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
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

### Plan Together, Then Let Codex Build

```bash
/stereo:plan add rate limiting to the public API
/stereo:implement
```

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

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/stereo:result` or `/stereo:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/stereo:setup` to check whether Codex is ready, and use `!codex login` if it is not.

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
