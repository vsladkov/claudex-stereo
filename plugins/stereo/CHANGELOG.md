# Changelog

## 1.24.0

- Accept an optional `codex:` prefix on every Codex model selection, stripped exactly once before
  alias, provider, and effort resolution, so `codex:sol` and `sol` address the same runtime model
  on every command
- Reject `codex:claude:*` and a bare `codex:` with explicit errors while keeping bare selections
  canonical in defaults, stored plan state, status output, and reports
- State one addressing rule in the README and routing skill: the prefix names the executing
  runtime, `claude:` stays required for the closed Claude Code set, and everything else is an open
  Codex passthrough

## 1.23.0

- Continue named-Claude implementation reviewers across fix-loop rounds within one command run,
  fall back to a fully re-briefed fresh invocation, and report continued versus re-briefed rounds
- Generalize the routing skill's continuation rule across both review roles while keeping Codex
  implementation reviews stateless: their full brief still travels every round, so resume would
  add thread history without saving payload and weaken fresh cross-ecosystem review independence
- Restate the README doctrine and usage warning around a fresh round 1, compact later-round
  continuation, and the fully re-briefed fallback

## 1.22.0

- Default `/stereo:implement` and `/stereo:quick` implementation review to `claude:fable`
- Invert the implementation-review doctrine so `--implementation-reviewer claude:session` is the
  economy path and `--implementation-reviewer sol` is the cross-ecosystem path
- Record the per-round cost of stateless implementation review: no continuation and one fresh
  top-tier contained reviewer for every round, including fix-loop re-reviews

## 1.21.0

- Default `/stereo:plan` to a fresh contained `claude:opus` planner and `claude:fable` plan
  reviewer, and default `/stereo:quick` plan review to `claude:fable` while keeping its grounded
  inline planner
- Default every `gpt-*` pair role to `max` effort, replacing the non-`gpt-5.6` `xhigh` fallback
- Rewrite the README's dogfooded model doctrine and record the default tradeoffs: no resumable
  Codex review thread, Claude-budget planning, intra-Claude plan-phase independence, and
  `--plan-reviewer sol` as the one-flag restore

## 1.20.0

- Carry non-empty approving plan-review findings into approved implementation payloads as advisory
  context and into every implementation-review brief
- Rename `--impl-reviewer` and `--impl-reviewer-effort` to `--implementation-reviewer` and
  `--implementation-reviewer-effort`, rejecting the abbreviated spellings with their replacements
- Document the dogfooded model-selection doctrine for routine work, critical changes,
  implementation review, and full-discovery sweeps

## 1.19.0

- Bound SessionEnd cleanup within an internal deadline below its hook timeout so reservation
  release, guarded broker shutdown, and synchronous session teardown can finish reliably
- Serialize each broker client's inbound JSONL dispatch and disconnect clients whose unterminated
  input exceeds the shared buffer cap
- Publish rendered pair-plan Markdown with the durable state's same-directory atomic rename helper
  and cover exact text writes plus temporary-file cleanup
- Remove the unused `eslint-plugin-import-x` registration and development dependency
- Repair the README links for Stereo status, cancellation, and review-gate documentation

## 1.18.0

- Tolerate malformed or non-object SessionStart, SessionEnd, and Stop hook input so cleanup and
  enabled review gates still run with empty-input semantics
- Preserve the last good stored pair plan when a reviewer returns parseable JSON without a
  verdict-bearing plan-review object, while retaining its result and summary for reporting
- Reuse Codex availability results within each CLI process instead of launching duplicate version
  and app-server probes
- Remove test-created temporary directories at process exit and safely clean newly leaked dead
  broker session directories during global teardown
- Consolidate runtime excerpt shortening on the shared text helper without changing existing
  explicit limits
- Remove the missing demo-video embed and correct contributor documentation for the release
  manifest count and test-temp debugging escape hatch

## 1.17.0

- Publish ordinary durable JSON state updates with same-directory atomic renames so concurrent
  readers never observe a partially written state, job, or pair-plan record
- Persist structured plan-review findings from both Codex and Claude review routes, render their
  severity and title in `/stereo:plan-state`, and carry them into every unapproved implementation
  route
- Preserve the legacy migration publisher's exclusive no-clobber behavior and keep terminal-state
  persistence failure coverage aligned with atomic replacement permissions

## 1.16.0

- Deliver every Codex pair-workflow payload through a temporary file instead of a fixed-delimiter
  heredoc, using `--plan-file`, `--prompt-file`, or stdin redirection as appropriate
- Allow the four read-only Claude planner and reviewer agents to use `WebFetch` and `WebSearch`
  when the running harness provides them
- Correct the Claude adversarial-review background rationale and document how live-source
  availability differs across Codex, named Claude agents, and the inline Claude session
- Add structural transport pins and success-path runtime coverage for delimiter-bearing plan and
  task payload files

## 1.15.0

- Add per-role Codex effort flags to Plan, Implement, and Quick while retaining `--effort` as the
  command-wide fallback
- Enforce the implementation-review schema in Codex task turns through the new
  `task --output-schema` runtime pass-through
- Continue named-Claude plan reviewers across rounds when the harness supports follow-ups, with
  the existing fully briefed stateless flow as a fallback
- Add `claude:inherit` for contained roles and document platform model precedence plus Claude's
  session, agent-definition, and model-selection reasoning controls

## 1.14.0

- Give Claude and Codex planners, plan reviewers, implementation reviewers, and adversarial
  reviewers the same canonical role brief, including stateless prior-review context
- Neutralize Codex-specific identities in shared review prompts and add repository-root
  `AGENTS.md` guidance for Codex contributor grounding
- Report per-invocation token usage and duration for both ecosystems, with Codex per-job and
  cumulative-thread counters labeled separately
- Strengthen prompt and command wiring tests so template placeholders and command fills cannot
  drift silently

## 1.13.0

- Add standalone draft, plan-review, implementation, and implementation-review step modes to the
  existing `/stereo:plan` and `/stereo:implement` phase commands
- Add complete per-role Claude/Codex routing to `/stereo:quick` and a schema-validated foreground
  Claude route to `/stereo:adversarial-review`
- Replace the phase and cycle commands' ambiguous model flags with `--planner`,
  `--plan-reviewer`, `--implementer`, and `--impl-reviewer`; the one-day-old v1.12 flag names are
  intentionally removed without compatibility aliases
- Centralize model addressing, agent invocation, validation, persistence, and Codex job mechanics
  in the internal `model-routing` skill, and add a canonical implementation-review schema
- Let `plan-store --round 0` represent an unreviewed stored draft while preserving round 1 as the
  omitted-flag default and keeping `plan-review` rounds one-based

## 1.12.0

- Add independent Claude or Codex model selection to `/stereo:plan` drafting/review and `/stereo:implement` implementation/review while preserving their existing checkpoint and defaults
- Add contained Claude planner, plan-reviewer, file-edit implementer, and implementation-reviewer agents, with foreground result validation and no shell access for Claude implementation
- Add `plan-store` and null-thread `/stereo:implement` continuation so Claude-reviewed plans persist, render, and resume through the existing pair-plan state

## 1.11.0

- Add `/stereo:plan-state --open` to refresh the rendered plan as `pair-plan.md` in durable companion state and best-effort open it through the VS Code `code` CLI, with a printed-path fallback

## 1.10.0

- Add `/stereo:plan-state` to render the complete stored pair plan with its verdict, review round, runtime metadata, open questions, and residual risks before implementation

## 1.9.1

- Name `job.progressPreview` explicitly in the plan, implement, and quick poll instructions so live progress and stall detection use the correct status-payload field

## 1.9.0

- Add `/stereo:quick` for small tasks: one command drafts and reviews a compact plan, moves approved plans directly into implementation, bounds the automatic plan and fix loops at two rounds, and preserves the existing dirty-worktree and never-commit safety gates

## 1.8.0

- Surface live diff statistics and plan-step updates from active Codex turns in existing job logs and nonterminal status progress previews, with registered-turn filtering and change-only emission

## 1.7.0

- Keep workspace config, job records and logs, and approved pair-plan state under `CODEX_HOME/companion-state` so state written by 1.7.0 and later survives plugin reinstalls; non-wiping upgrades migrate older state once
- Surface per-job and cumulative-thread token usage in detailed status and stored results, and show available account rate limits during setup
- Ask before waiting only when pair-workflow progress has actually stalled, instead of interrupting healthy long-running jobs based on total elapsed time
- Note: upgrading from 1.6.x or earlier via uninstall/reinstall still loses the old plugin-data state one final time because uninstall removes it before 1.7.0 migration code can run

## 1.6.1

- Bound broker endpoint probes across close-only and silent connection races, with outcome-aware readiness and teardown checks
- Remove the superseded TypeScript migration notes

## 1.6.0

- Route provider-qualified model selections such as `model@provider` with the bare model id while preserving the qualified value in job state and output
- Add injectable dependency seams for cancel and detached task-worker command handlers
- Continue cancellation from index data when a stored job file is unreadable, with explicit log, text, and JSON warnings
- Let idle workspace-record-owned brokers self-terminate after their ownership record is removed or replaced, while leaving record-less brokers untouched
- Make failed plan-review retries round-aware so later rounds retain their required thread context

## 1.5.0

- Recover turns whose broker client disconnects before the streaming start response, including fast completions and detached reviews, without installing dead socket ownership
- Release dead workers' thread reservations after orphan completion through identity-verified exclusive cleanup claims

## 1.4.2

- Degrade stored result reads to index-only output with an explicit warning when job JSON is unreadable, and clear stored effort when implementation overrides the model without an effort override

## 1.4.1

- Align rescue alias and effort forwarding with runtime resolution, preserve provider and model visibility in setup/status, omit null stored efforts during implementation, and clarify stop-gate output formatting
- Poll pair-workflow runs in short windows with per-poll phase notes so long Codex turns show live progress instead of one silent multi-minute wait

## 1.4.0

- Terminalize foreground and background companion jobs on SIGTERM/SIGINT, release only reservations whose turns are proven not to be running, and retain in-flight locks for the existing stranded-reservation remedies

## 1.3.2

- Adopt the Prettier + ESLint toolchain (repo-wide reformat, husky pre-commit on staged files, CI format and lint gates); no behavior changes

## 1.3.1

- Show the active and configured model providers in setup, including whether each declared provider environment key is set
- Persist requested models on every tracked job and show provider-qualified model names in status and stored results

## 1.3.0

- Add Kimi, Qwen, DeepSeek, and GLM model aliases with per-thread custom-provider routing
- Omit the pair workflow's default reasoning-effort override for third-party models while preserving existing OpenAI defaults
- Document Codex's Responses-only custom-provider contract and add a user-runnable provider compatibility probe

## 1.2.1

- Session end kills its own running jobs before probing the shared broker, so ending a session mid-task reliably reaps the broker instead of leaving it running forever
- Interrupt abandoned turns even when the owner dies before `turn/started` arrives; re-interrupt and extend the recovery gate once if the turn ignores the first interrupt; stop forwarding an orphaned turn's completion to unrelated clients
- Grow markdown fences past embedded backtick runs when rendering raw Codex output, so reviewer prose containing code blocks cannot break report formatting
- Require `--thread` for plan-review rounds above 1 (the revision framing is meaningless in a fresh thread)
- Cap retained app-server stderr at 64KB in direct-session clients
- Replace nonexistent `gpt-5.4` model names in README examples and the prompting skill (now `codex-prompting`) with the real aliases; document `--model` on `/stereo:review` and `/stereo:adversarial-review`

## 1.2.0

- Migrate the runtime to TypeScript: layered `src/` architecture (cli, workflows, runtime, jobs, broker, transport, workspace, render, models, shared) running natively on Node >= 24 type stripping - no build step; typed model registry as the provider expansion point
- Require Node.js 24 or later
- Session end now shuts the shared workspace broker down only when it is idle, so ending one Claude session no longer kills another session's in-flight Codex turn; a hard kill remains only for wedged brokers that are verified still alive
- Fast-fail foreground `task` invocations with no prompt or resume target before a job record is created, matching the background path
- Tolerate malformed stop-hook input instead of silently bypassing an enabled review gate
- Keep test machines clean: the test suite reaps the brokers it auto-starts (one full run used to strand ~40 processes)

## 1.1.0

- Add `/stereo:plan` and `/stereo:implement`: a dual-model pair workflow where Claude drafts and revises an implementation plan, Codex adversarially reviews it until approval, Codex implements the approved plan in the same thread, and Claude reviews the diff with iterative fix rounds
- Add the `plan-review` and `plan-state` companion subcommands with a structured plan-review schema, prompt template, and renderer
- Add `--thread <id>` to the `task` subcommand for resuming an explicit Codex thread (including read-only to workspace-write escalation)
- Add the `sol` model alias mapped to `gpt-5.6-sol`
- Add `--verbose` output to `/stereo:status`
- Default gpt-5.6-family model overrides to `max` effort in the pair workflow
- Check the Codex write sandbox during `/stereo:setup` and explain likely host-level launch failures
- Add `terra` and `luna` aliases mapped to `gpt-5.6-terra` and `gpt-5.6-luna`
- Speed up pair workflows with longer command polling windows, smaller shared job-index records, and repository-map context on fresh plan-review rounds
- Retry ignored read-only-to-write escalation once on a private runtime, serialize concurrent turns per Codex thread, and drain stale owned brokers only when idle
- Fail turns promptly when their app-server connection closes instead of waiting indefinitely
- Warn when a write-capable task reports no file changes, including in stored background results
- Surface stranded thread reservations with state-aware remedies in `/stereo:setup` and `/stereo:status`
- Judge plan reviews against the plan's own goal and out-of-scope sections, report out-of-scope hazards as non-blocking `residual_risks`, allow explicit descopes, and default the plan loop to 6 rounds and the implement fix loop to 4
- Preserve finished jobs (results and logs) when a session ends; only the session's queued and running jobs are cleaned up
- Mark running jobs whose worker process has died as `stalled` in `/stereo:status`
- Harden the shared broker: survive bad client writes, never wedge busy after an instantly-completing turn, drop stalled clients instead of buffering unbounded output, and restrict the unix socket to the owning user
- Keep the stop-time review gate working under symlinked plugin installs
- Emit structured `{"error": ...}` JSON on stdout when a `--json` command fails

## 1.0.0

- Initial version of the Codex plugin for Claude Code
