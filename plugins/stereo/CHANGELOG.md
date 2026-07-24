# Changelog

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
