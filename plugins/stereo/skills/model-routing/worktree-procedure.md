# Worktree procedure

`/stereo:implement --isolated` (and a resume of an isolated record), `/stereo:quick --isolated`,
and `/stereo:tournament` read this file after the other routing files they read and cite its
section by heading.

## Isolated worktrees

A command that implements in a throwaway worktree follows these steps; its own text names the entry
conditions, the durable fields it records, the terminal exits that trigger hand-back, and any step
it replaces. Set `<mainRoot>` to `git rev-parse --show-toplevel`. The worktree is detached and
temporary; no command in this flow creates a branch or commit.

1. **Extra preflight.** After recording `baselineCommit` and the baseline-dirty paths, if the main
   tree is dirty, explain that the isolated worktree starts from `HEAD` and therefore does not
   contain those uncommitted changes, and that hand-back refuses patched paths that overlap the
   dirty set. Ask exactly once whether to stop and commit/stash (recommended) or continue. If the
   stop-time review gate is enabled (`reviewGateEnabled`), also explain that it reviews the main
   tree, which remains clean during the isolated run, and point to
   `/stereo:setup --disable-review-gate`.
2. **Creation.** Create and provision the worktree with one companion call:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" worktree create --main '<mainRoot>' --json
   ```

   It picks a fresh directory under the operating system's temporary directory
   (`stereo-worktrees/<repo>-<id>`), adds a detached worktree there at `HEAD`, links dependencies
   (step 3), and prints `{ path, linked, skipped, removeCommand, rendered }`. Save `path` — the
   canonical path git reports — as `<worktreePath>` and `removeCommand` — the companion's own
   removal command, runnable as printed — as `<removeCommand>`, and use exactly those strings from
   then on: `<worktreePath>` in `<isolationArgs>`, every command, the durable record, and the
   resume check against `git worktree list --porcelain`; `<removeCommand>` wherever the worktree
   is left in place. Print `<worktreePath>` as soon as creation succeeds. A `{"error": …}` reply is
   a creation failure: report it verbatim and stop without launching an implementer.

3. **Dependency provisioning.** `worktree create` symlinks each dependency directory the main tree
   already ignores — `node_modules`, `.venv`, `venv`, `vendor/bundle`, never `target` — listed in
   `linked`; an unignored or already present directory is listed in `skipped` and not linked. The
   links share the main checkout's installed dependencies, which must not change: every implementer
   prompt forbids installing into or modifying them. When the plan builds or tests artifacts and a
   dependency it needs is neither linked nor present, run the repository's documented install
   command targeted at the worktree — never speculatively for a document-only plan. Record the
   provisioning as `symlink`, `install`, or `unprovisioned`, and state it in every implementer
   prompt.

   A command that takes a baseline gate snapshot ("Staged verification") takes it here — in the
   worktree after provisioning, using the worktree-gates step's recipes — instead of on the main
   tree: static gates only, since a fresh checkout at `HEAD` is never dirty. A gate the recipes
   cannot run stays unsnapshotted, so its reds are unattributable.

4. **Companion routing.** In isolated mode `<isolationArgs>` is:

   ```text
   --cwd '<worktreePath>' --workspace '<mainRoot>'
   ```

   `--cwd` sets the job's working directory — the Codex thread cwd, or the directory a headless
   Claude session runs in and every one of its shell commands starts from — which confines the
   implementer's writes to the worktree for either runtime, so a companion implementer or reviewer
   runs commands verbatim from there. `--workspace` keeps the job record, log, durable state, and
   shared broker keyed to the main workspace, so `/stereo:status`, `/stereo:result`, and
   `/stereo:cancel` work unchanged from the main repository. `<isolationArgs>` goes on every
   companion launch that targets the worktree, implementer turn and review alike: a launch-arguments
   file records no working directory ("Implementer launches and payloads").

5. **Post-turn containment guard.** After every implementation or fix turn, run
   `git -C '<mainRoot>' status --porcelain=v1 --untracked-files=all` and compare its exact path set
   with the recorded baseline-dirty set. Any new main-tree path means the implementer wrote outside
   the worktree: stop, report the paths verbatim, and do not continue the loop. Companion-reported
   `touchedFiles` are absolute to the worktree; do not mistake them for main-tree writes.
6. **Review and verification target.** Use `git -C '<worktreePath>' ...` for every diff, status,
   and file inspection. `{{BASELINE_CONTEXT}}` must say that the delta lives in the isolated
   worktree at `<worktreePath>`, provide its `baselineCommit`, and say that fix `file` values remain
   repository-relative and are identical in both trees. For a `claude:session` reviewer, provide the
   absolute worktree path and require inspection with `git -C '<worktreePath>'`, absolute Read
   paths, and worktree-targeted verification commands (`npm --prefix '<worktreePath>' test`, a
   tool's directory flag). If the harness denies reads outside the main workspace, fall back to the
   complete diff already embedded in `{{BASELINE_CONTEXT}}` and record that limitation in the round
   note.
7. **Worktree gates.** The orchestrator runs repository gates with the worktree as their working
   directory. A provisioned worktree runs the inner loop and the fast stage natively: for npm
   projects use `npm --prefix '<worktreePath>' test`, and the corresponding `npm --prefix` form for
   every other script. An unprovisioned worktree falls back to the main checkout's toolchain per
   gate, through command forms the frontmatter grants cover — for an npm-family project, for
   example: run the format check as
   `node '<mainRoot>/node_modules/prettier/bin/prettier.cjs' --check --ignore-path '<worktreePath>/.gitignore' '<worktreePath>'`;
   run the typecheck as
   `node '<mainRoot>/node_modules/typescript/bin/tsc' --noEmit -p '<worktreePath>/tsconfig.json' --typeRoots '<mainRoot>/node_modules/@types'`
   after any generation step the project's typecheck depends on; record a lint whose config
   resolves plugins through a local `node_modules` as not runnable. Record per gate whether it ran
   natively, through the main toolchain, or not at all; record anything that cannot run as
   `not runnable in the isolated worktree`, carry it into `{{HOST_RESULTS}}` and the final report,
   and do not call it passed. Every pre-hand-back result is a `provisional worktree check`; after a
   confirmed hand-back, rerun the complete fast stage in the main tree — the authoritative result —
   before the final report.
8. **Delta hand-back.** At every terminal exit the command names, create a patch under the
   "Quoting" temporary-directory rule, never inside either repository tree. `<patchFile>` is that
   patch's absolute path: a fresh file, chosen before the commands below run:

   ```bash
   git -C '<worktreePath>' add -N .
   git -C '<worktreePath>' diff --binary --no-ext-diff '<baselineCommit>' > '<patchFile>'
   git -C '<worktreePath>' diff --stat '<baselineCommit>'
   git -C '<worktreePath>' diff --name-only '<baselineCommit>'
   ```

   If the patch is empty, say so and proceed directly to cleanup. Otherwise recompute
   `git -C '<mainRoot>' status --porcelain=v1 --untracked-files=all` and
   `git -C '<mainRoot>' rev-parse HEAD`. Report every overlap between patched paths and currently
   dirty main-tree paths and report when `HEAD` moved from `baselineCommit`. Show the patch stat and
   ask exactly once:

   - `Apply the patch to the working tree (Recommended)`
   - `Leave the patch and the worktree for me`
   - `Discard the worktree without applying`

   When `HEAD` moved, include in that question that a 3-way merge may conflict. On apply, capture
   the pre-apply status, run `git -C '<mainRoot>' apply --3way --check '<patchFile>'`, and only
   after it succeeds run `git -C '<mainRoot>' apply --3way '<patchFile>'`. The check validates
   pre-images and index compatibility, but with `--3way` it does not detect every merge conflict:
   the real apply can still exit nonzero, leave conflict markers, and create unmerged index entries
   on paths that were clean before it. A successful `--3way` apply stages the delta because it
   implies `--index`; nothing is committed or pushed, and unrelated staged work already in the index
   stays staged beside it (report that when the pre-apply status had any). On failure at either
   step, report git's exact output and `git -C '<mainRoot>' diff --name-only --diff-filter=U`,
   identify real-apply conflict paths as having been clean before the apply, keep the patch and
   worktree, and hand resolution to the user. Explain that those paths can be returned to their
   pre-apply `HEAD` state with a user-chosen `git reset -- <paths>` followed by
   `git checkout -- <paths>` (files the patch newly added are removed by hand); do not run that
   recovery automatically.

   An empty patch skips the main-tree rerun (nothing was applied) and counts as applied-and-green
   for the command's lifecycle decisions. A command marks the plan implemented only after the
   hand-back resolves to an applied or empty patch AND the authoritative post-hand-back main-tree
   rerun is green; a red rerun is not-verified (report it and skip the marker), and a discarded
   delta skips the marker and says so.

9. **Cleanup.** After a successful apply, an empty patch, or the discard choice (the patch file
   stays recoverable), remove the worktree:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" worktree remove --main '<mainRoot>' --path '<worktreePath>' --json
   ```

   It prints `{ removed, rendered }` and refuses a path that is not a linked worktree of
   `<mainRoot>`; report a refusal verbatim. In every other case — leave, or a failed apply —
   print `<worktreePath>`, `<patchFile>`, and `<removeCommand>` (never a raw
   `git worktree remove --force`), and say the worktree was intentionally left in place.
