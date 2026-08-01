# Codex contributor notes

Read `CLAUDE.md` first. It is canonical for the repository layout, TypeScript discipline, tests,
development workflow, and runtime invariants.

Codex-specific operating notes:

- Pair-turn sandboxes deny subprocess spawning and socket listening, so the full `node:test` suite
  cannot run there. Run targeted structural or in-process tests when possible and leave the full
  repository gates to the orchestrator.
- Markdown tables and formatting are Prettier's (printWidth 100, proseWrap preserve); the
  ~100-column prose wrap is a hand-maintained convention no gate enforces — preserve it when
  editing markdown. Run `npm run format:check` before finishing; the orchestrator runs the full
  gates either way.
- Never commit or push repository changes.
- Make release version changes with `npm run bump-version <version>` so every manifest stays in
  sync.
