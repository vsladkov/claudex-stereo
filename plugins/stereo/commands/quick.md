---
description: Plan, review, implement, and verify one small task with Claude and Codex in a single pair workflow
argument-hint: '[--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [small task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run the complete dual-model pair workflow for one small task. The detailed loop rules in
`/stereo:plan` and `/stereo:implement` are canonical; this command mirrors them with fixed quick
caps and no approval gate between an approved plan and implementation.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- `--model` and `--effort` are runtime-selection flags. Forward user overrides to every
  `plan-review` call, then use the resolved model and effort returned by the latest plan-review
  payload for implementation and fix calls. When the resolved effort is null, omit `--effort`.
- All remaining text is the task description. If it is empty, ask the user what small task to
  complete before doing anything else.
- Quick has fixed automatic caps: 2 plan-review rounds and 2 implementation fix rounds. It has no
  round-count flags.

Scope of the result-handling rules:

- This command is a deliberate, user-invoked iterative workflow.
- Inside its review and fix loops, act on findings without asking the user except at the explicit
  decision points below.

Phase 0 - Scope gate and compact plan:

- Explore the repository with Read, Glob, Grep, and read-only git commands until you can name the
  exact files, symbols, and integration points.
- Quick is only for one small feature whose honest plan fits roughly 120 lines. If the task spans
  multiple features or subsystems, or the draft would exceed that bound, stop before round 1 and
  tell the user to run `/stereo:plan` instead.
- Draft a self-contained plan with exactly these sections: `## Goal`, `## Approach`,
  `## Files to change`, `## Step-by-step changes`, `## Testing and verification`,
  `## Risks and edge cases`, `## Out of scope`.
- Do not write the plan into the repository. Send it through quoted heredoc stdin.

Phase 1 - Existing plan-state warning:

- After the task passes the scope gate but before launching round 1, inspect the current
  repository's stored plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

- If `available` is `true`, post a one-line warning that this quick run will replace the stored
  plan, naming its `summary` and `updatedAt`. Do not claim to know whether it was implemented;
  plan-state does not record that. This is a warning, not another user gate.
- Do not read plan-state again during this run. Carry the current plan, thread id, model, effort,
  findings, open questions, and residual risks from the review result payloads in this
  conversation.

Phase 2 - Capped Codex plan review:

- Launch round 1 in the background. In the templates, `<selectionArgs>` is the user's
  `--model`/`--effort` overrides when present and nothing otherwise.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <selectionArgs> <<'CODEX_PAIR_PLAN'
<full plan document>
CODEX_PAIR_PLAN
```

- Parse the launch JSON for `jobId`, then poll until the job leaves `queued`/`running`, passing a
  Bash timeout of 120000 for each poll:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 --json
```

- After every non-terminal poll, post one progress line with phase, elapsed time, and the latest
  progress line (the last entry of the payload's `job.progressPreview` array; it is empty once a job
  completes), then poll again.
- If a launch or poll prints a top-level `{"error": ...}` object, surface it and stop the loop.
- No phase change and no new `job.progressPreview` entry for roughly 10 minutes is a stall. Ask once:
  `Keep waiting (Recommended)` or `Cancel the review and stop`. Advancing progress is not a stall,
  regardless of total elapsed time.
- At terminal status, fetch the stored result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --json
```

- Read `storedJob.result`: carry `.threadId`, `.model`, `.effort`, `.result.verdict`,
  `.result.findings`, `.result.revision_instructions`, `.result.open_questions`,
  `.result.residual_risks`, and `.parseError`. Refresh the thread id from every round.
- If `parseError` is set, resubmit the same plan and round once on `--thread <threadId>`. If it
  fails again, show the raw output and ask `Stop and treat the plan as unapproved` or
  `Continue revising anyway`.
- If a job is `failed`, retry round 1 once without `--thread`, or a later round once on the same
  thread. If that retry fails, restart as round 1 on a fresh thread while carrying accumulated
  `## Reviewer responses` in the plan. Surface the error if that restart also fails.
- On `needs-revision`, address every finding by changing the plan, rebutting it with repository
  evidence under `## Reviewer responses`, or explicitly descoping scope-expanding/pre-existing
  hazards into `## Out of scope` with a documented residual. Carry material `residual_risks` into
  `## Risks and edge cases`.
- Resubmit the full revised plan on the current thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <threadId> --round <n> <selectionArgs> <<'CODEX_PAIR_PLAN'
<full revised plan document>
CODEX_PAIR_PLAN
```

- Post a one-line round/verdict/finding-count update after every completed round.
- On `approve`, continue directly to Phase 3 without asking the user.
- After round 2 still returns `needs-revision`, show the latest findings and ask once:
  `Keep iterating (Recommended)`, `Implement anyway`, or `Stop here`.
  - `Keep iterating` stays inside quick, revises on the same thread as round 3, and follows the
    canonical scope-accretion and repeated-finding safeguards through a total cap of 6 rounds.
    Rounds 3-5 continue automatically while converging. At round 6 without approval, ask only
    `Implement anyway` or `Stop here`.
  - `Implement anyway` records the current findings as original unapproved review findings and
    enters the truthful unapproved branch in Phase 3. Do not ask about the verdict again.
  - `Stop here` reports the latest findings and stops. The unapproved plan remains stored, so a
    later `/stereo:implement` will show its normal non-approve gate.
- If the plan grows beyond roughly 1.5 times its round-1 size, a finding targets review-added
  machinery, the same finding survives two explicit rebuttals, or the plan oscillates between
  shapes, pause at the same decision point instead of looping blindly.

Phase 3 - Implementation preflight:

- Use the current in-conversation plan and latest review payload; never reload plan-state.
- Show a one-line recap of the plan summary and review rounds. Mention documented residual risks
  when present.
- Record `git rev-parse HEAD`, `git status --porcelain=v1 --untracked-files=all`, and all paths
  already dirty as the rollback/review baseline.
- If the worktree is dirty, ask once: `Stop so I can commit or stash first (Recommended)` or
  `Continue with a dirty worktree`.
- If the stop-time review gate is enabled, mention that finishing quick triggers one extra Codex
  review and that `/stereo:setup --disable-review-gate` avoids it during long pair sessions.

Phase 4 - Codex implements:

- Use the latest plan thread by default. Let `<effectiveModel>` and `<effortArg>` represent the
  resolved review model and optional `--effort <effectiveEffort>`.
- For an approved plan, use the canonical implementation prompt:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <threadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier in this thread.

[current full plan text, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. If a step turns out to be impossible, say so explicitly instead of silently skipping it.
</completeness_contract>
<verification_loop>
Run the repository's relevant tests or build before finalizing and fix what you break.
</verification_loop>
<compact_output_contract>
Report: a summary of the changes, the files you touched, the verification you ran with results, and any deviations from the plan with reasons.
</compact_output_contract>
CODEX_PAIR_IMPL
```

- If the user chose `Implement anyway`, use the same command and contracts but replace the
  `<task>` block with this truthful version:

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was not approved in this thread; the latest review findings are known open issues. Implement the plan as specified and address a finding where the plan already covers its remedy. Do not silently expand scope.

[current full plan text, verbatim]

Latest unapproved review findings:
[latest findings, verbatim]
</task>
```

- Poll like the plan loop, using a Bash timeout of 600000 per poll:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 --json
```

- Post phase, elapsed time, and the latest `job.progressPreview` entry after non-terminal polls.
  Treat 10 minutes without a phase change or a new `job.progressPreview` entry as stalled and ask
  `Keep waiting (Recommended)` or
  `Cancel the implementation and stop`.
- Fetch terminal output with `result <jobId> --json`. Surface top-level JSON errors.
- If resume fails, or `touchedFiles` is empty and git shows no delta against the baseline despite
  claimed changes, retry once with `task --background --json --write --fresh`, the identical full
  prompt, and a note that prior thread context is unavailable. Keep the truthful unapproved
  wording and findings in that branch. If the fresh run still makes no change, surface it.
- Always adopt the thread id from the latest implementation payload.

Phase 5 - Claude reviews and fixes:

- Inspect `git status --short --untracked-files=all`, `git diff`, and every changed or untracked
  file. Ignore paths already dirty in the baseline when attributing the delta.
- Run the identifiable project test suite or build on the host when permission is available.
- Verify the implementation against every plan step, earlier review finding, and reported
  deviation. For every original unapproved review finding, maintain a verified status:
  `resolved` only when the delta and tests prove it; otherwise `unresolved`.
- If acceptable, continue to the final report. Otherwise send a numbered fix list with file/line,
  the defect, and the correct result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <threadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_FIX'
<task>
Fix the review findings below in this repository. Keep all other behavior unchanged.

[numbered fix list]
</task>
<verification_loop>
Run the repository's relevant tests or build before finalizing and fix what you break.
</verification_loop>
<compact_output_contract>
Report which findings you fixed, how, and what verification you ran.
</compact_output_contract>
CODEX_PAIR_FIX
```

- Poll, fetch, update to the latest thread id, and re-review after each fix.
- After 2 fix rounds, present remaining issues and ask:
  `Send one more Codex round`, `Let Claude fix the rest directly`, or `Stop and report as-is`.

Final report:

- Summarize fix rounds used, files Codex touched, tests run and their results, deviations, and all
  carried `open_questions` and `residual_risks` from the latest plan review.
- If the unapproved branch was used, list every original review finding with its verified final
  status (`resolved` or `unresolved`) and evidence from the delta/tests. Never label a finding
  unresolved merely because it appeared in the pre-implementation review.
- Include `Codex session ID: <threadId>` and `Resume in Codex: codex resume <threadId>`.
- State plainly that nothing was committed. Give rollback guidance relative to the recorded
  baseline: `git restore` for newly modified tracked paths and cautious `git clean` guidance for
  new paths, without erasing paths that were already dirty.
- Never commit. Never push.
- If Codex is missing or unauthenticated at any point, stop and tell the user to run
  `/stereo:setup`.
