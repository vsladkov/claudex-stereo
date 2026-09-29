---
name: codex-prompting
description: Internal guidance the stereo:codex-rescue subagent uses to compose prompts for Codex CLI models (coding, review, diagnosis, research); the main session does not load it
user-invocable: false
---

# Codex CLI Model Prompting

Use this skill when `stereo:codex-rescue` needs to ask a Codex CLI model for help.

Prompt Codex like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:

- Give a Codex run one clear task. A rescue handoff is a single run: when the request holds unrelated asks, put the main one in `<task>` and list the others after it, instead of splitting them over several runs.
- Tell Codex what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning or adding long natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Default prompt recipe:

- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Codex should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:

- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or adversarial review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Codex stays narrow and avoids unrelated refactors.

How to choose prompt shape:

- A rescue handoff is one `task` call whatever the job: diagnosis, planning, research, implementation, or a review the user asked the rescue for. `/stereo:review` and `/stereo:adversarial-review` carry the review contract for local git changes; the user runs those, and the rescue subagent never calls them.
- A follow-up on the same Codex thread is a `task` call with `--resume-last`. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

Working rules:

- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names that match the block names from the reference file.
- Do not raise reasoning or complexity first. Tighten the prompt and verification rules before escalating.
- Ask Codex for brief, outcome-based progress updates only when the task is long-running or tool-heavy.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Prompt assembly checklist:

1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether Codex should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
