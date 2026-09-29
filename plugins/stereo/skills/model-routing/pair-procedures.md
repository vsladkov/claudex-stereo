# Pair command procedures

`/stereo:plan`, `/stereo:implement`, `/stereo:quick`, and `/stereo:tournament` read this file after
`SKILL.md` beside it and cite its sections by heading; each command's own text keeps its step
order, mode flags, rejections, questions, durable records, and every step it marks as different.

## Selection and effort parsing

Parse every argument after reading the routing files and before inspecting the repository or
starting a routed step. Reject missing values, duplicate role or role-effort flags, invalid effort
or round values, the selections "Model addressing" rejects, and unknown flags, a command-wide
`--effort` among them ("Effort"); name the role flags (`--planner`, `--plan-reviewer`,
`--implementer`, `--implementation-reviewer`, and their `-effort` forms).

Resolve each role's model per "Workspace role defaults" and validate each role effort flag per
"Effort". Pin each companion role with its dry run ("Pinned selections"): the planner and the plan
reviewer before their first launch, the implementer and the implementation reviewer in the
implementation preflight. A selection or effort the companion refuses fails at that dry run, before
any job record: relay the error and stop ("Launch errors").

Invocation placeholders:

- `<slotArg>` = `--slot '<slot>'` when the run targets a non-default slot; omitted entirely for the
  `default` slot.
- `<plannerSelectionArgs>` = `--model '<plannerSelection>' <plannerEffortArg> --role planner`, and
  `<reviewSelectionArgs>` = `--model '<planReviewerSelection>' <planReviewerEffortArg>`
  (`plan-review` implies its role). Each selection is the role's selection as resolved for its
  pinning dry run and its pinned `selection` for every launch after it.
- `<plannerEffortArg>`, `<planReviewerEffortArg>`, `<effortArg>` (the implementer), and
  `<reviewEffortArg>` (the implementation reviewer) are `--effort '<effort>'` only when the user
  passed that role's effort flag, and omitted entirely otherwise.
- `<implementerRoleArgs>` = `--role implementer`, plus, for a named Claude implementer only, one
  `--allow '<rule>'` per `implementerAllowRules` entry. `<reviewRoleArg>` =
  `--role implementation-reviewer`, plus, for a named Claude reviewer only, one `--allow '<rule>'`
  per granted command, for example `--allow 'Bash(npm test)'`.
- `<isolationArgs>` is empty outside an isolated run; the worktree procedure defines its isolated
  form.

## Final report lines

Every round note and final report is built from these lines:

- **Usage line**: per-invocation usage and duration for every routed turn — `tokenUsage.job` from
  that turn's fetch — naming the job id, thread id, model, and the effort the job applied
  ("Effort"), with `usage unavailable` when metrics were omitted. An inline `claude:session` turn
  reports no usage line and no effort. Label `tokenUsage.thread` cumulative when shown.
- **Thread line**: each thread id labeled by role — a Codex thread id or a Claude session id —
  with the matching resume command, `codex resume <id>` or `claude --resume <id>`. Only
  `implementationThreadId` is an implementation resume target; the planner, plan-review, and
  implementation-review ids are labeled by role and never presented as one.
- **Claude invocation note** for every Claude turn, as "Companion invocations for Claude roles"
  defines it (served model, cost, denials).
- **Slot line**: the stored plan slot and its follow-up command — `/stereo:implement` for
  `default`, `/stereo:implement --slot <slot>` for a named slot.
- **Verification lines**: results itemized by stage under their route-specific labels; never
  present an implementer-reported check as an orchestrator gate result.
- **Isolated-run lines**: the worktree path, its provisioning (`symlink` with the `linked`
  directories, `install`, or `unprovisioned`, plus any `skipped` directory), the patch file, the
  hand-back decision and result including `staged, not committed` on success and every conflicted
  path on failure, whether the worktree was removed (its removal command when it was not), each
  worktree gate's provenance — native, main toolchain, or `not runnable in the isolated worktree`
  — and the result of the authoritative post-hand-back main-tree rerun.
- **Commit line**: rollback guidance relative to `baselineCommit` without erasing baseline-dirty
  paths; state that nothing was committed or pushed only if HEAD is unchanged, otherwise retract
  that claim and report the observed change. Never commit or push.
