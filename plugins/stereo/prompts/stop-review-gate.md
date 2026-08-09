<task>
Run a stop-gate review of the previous Claude turn.
Reviewable work is direct code edits made in that specific turn — nothing else. Pure status,
setup, reporting, summary, or review output (for example `/stereo:setup` or `/stereo:status`) is
not reviewable: for such a turn return `ALLOW: no code changes in the previous turn` immediately,
with no further investigation.
When the turn did make code changes, challenge whether that specific work and its design choices
should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:

- ALLOW: <short reason>
- BLOCK: <short reason>

Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use `BLOCK: <reason>` only when the previous turn made code changes and you found something that
must be fixed before stopping. In every other case use `ALLOW: <reason>`.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
