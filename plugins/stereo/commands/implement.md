---
description: Have Codex implement the plan approved in /stereo:plan, then review the diff and iterate until accepted
argument-hint: '[--model <model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-fix-rounds <n>] [--fresh]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run the implementation half of the dual-model pair workflow through the shared plugin runtime.
Codex writes the code in the same thread that reviewed the plan (by default `gpt-5.6-sol` at `max` effort); you (Claude) review each round and send back fixes until the implementation is acceptable.

Raw slash-command arguments:
`$ARGUMENTS`

Scope of the result-handling rules:
- This command is a deliberate, user-invoked iterative workflow.
- Within it, the `codex-result-handling` rule to STOP after presenting findings applies only at the user-decision points defined below.
- Inside the fix loop, act on your own review findings and send fix rounds to Codex without asking the user.

Phase 0 - Preflight:
- Load the stored plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

- If `available` is `false`, stop and tell the user to run `/stereo:plan` first.
- If `verdict` is not `approve`, use `AskUserQuestion` once with `Run /stereo:plan first (Recommended)`, `Implement the unapproved plan anyway`, and `Stop here`.
- Show the user a one-line recap of what will be implemented: the plan summary, the round count, and the `updatedAt` timestamp. If the stored plan carries `residualRisks`, mention there are documented non-blocking residuals that will be listed in the final report. If the plan looks stale relative to recent repo changes, say so before continuing.
- Check the worktree with `git status --porcelain=v1 --untracked-files=all` and record `git rev-parse HEAD` plus the list of already-dirty paths as the baseline.
- If the worktree is dirty, use `AskUserQuestion` once with `Stop so I can commit or stash first (Recommended)` and `Continue with a dirty worktree`.
- If the stop-time review gate is enabled, mention that finishing this command triggers one extra Codex review and that `/stereo:setup --disable-review-gate` avoids it during long pair sessions.

Phase 1 - Codex implements:
- Send the implementation run to the stored pair thread with write access. Never run it in the foreground: long `max` runs can exceed the Bash timeout.
- Embed the full stored plan text verbatim from `plan-state`, and use the stored `model`/`effort` unless the user overrode them.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <threadId> --model <storedModel> --effort <storedEffort> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier in this thread.

[full stored plan text, verbatim]
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

- `--fresh` from the user skips the stored thread and starts a new one (still embed the full plan and pass `--write`, without `--thread`).
- Poll exactly like `/stereo:plan`, with a Bash `timeout` of 600000 per poll call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 540000 --json
```

- Then fetch the payload with `result <jobId> --json`.
- If the run fails on resume, or `touchedFiles` is empty and `git status` shows no delta against the baseline even though Codex claims changes, retry once as a fresh run with `task --background --json --write --fresh`, the same prompt, and a note that earlier thread context is unavailable. If there is still no change, surface it to the user.

Phase 2 - Claude reviews and iterates:
- Inspect the delta yourself: `git status --short --untracked-files=all`, `git diff`, read the changed and untracked files, and ignore paths that were already dirty in the baseline.
- Run the project's test suite or build where one is identifiable (this may prompt for permission).
- Check the implementation against every plan step and every earlier review finding.
- If the implementation is acceptable, go to the final report.
- Otherwise write a numbered fix list - for each issue: file and line, what is wrong, and what correct looks like - and send it to the same thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <threadId> --model <storedModel> --effort <storedEffort> <<'CODEX_PAIR_FIX'
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

- Then poll, fetch the result, and re-review. Repeat until the implementation is acceptable.
- Always send fix rounds to the thread id from the latest implementation payload - after a `--fresh` fallback that is the new thread, not the one stored with the plan.

Stall safeguards (these are safeguards, not caps):
- When the fix-round cap is reached (`--max-fix-rounds <n>`, defaulting to 4 when absent - healthy loops finish in 0-2 fix rounds), stop and present the remaining issues with `AskUserQuestion`: `Send one more Codex round`, `Let Claude fix the rest directly`, `Stop and report as-is`.
- If the same issue survives three fix rounds, pause and ask the same question instead of looping forever.

Final report:
- Summarize: fix rounds used, the files Codex touched, the tests you ran with their results, and any unresolved `openQuestions` and `residualRisks` stored with the plan (the residuals are documented non-blocking hazards with suggested follow-up plans - list them so the user can schedule them).
- Include `Codex session ID: <threadId>` and `Resume in Codex: codex resume <threadId>`.
- State plainly that nothing was committed, and how to roll back relative to the recorded baseline (`git restore` for modified paths, `git clean` guidance for new ones).
- Never commit. Never push.
- If Codex is missing or unauthenticated at any point, stop and tell the user to run `/stereo:setup`.
