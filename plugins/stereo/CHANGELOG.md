# Changelog

## 1.44.0

- Give the Claude implementer a shell scoped to building and testing, with tool parity across
  ecosystems: it builds the repository, runs the unit tests and static checks that exercise its
  changes, and fixes the failures its changes introduced inside its own turn — failures it cannot
  attribute to its edits are reported as suspected pre-existing instead of fixed — and its report
  carries a new `Verification` section listing every command with its exit status. Later fix
  turns continue the same agent with just the numbered findings instead of a full re-brief
- Stage orchestrator verification and make it route-dependent: build and unit results an
  implementer produced on the host are trusted without a redundant re-run (only the cheap static
  checks repeat before review), sandbox results stay advisory and get the complete fast battery,
  and a repository-declared heavy stage (integration, end-to-end, real runs) executes strictly
  after an accepted implementation review, never re-running unit tests
- Attribute red gates instead of blindly fixing them: a risk-matched baseline snapshot (static
  checks always, the unit suite only over a dirty baseline, taken inside the worktree for
  isolated runs) classifies each failure; a bounded gate-fix pre-loop repairs newly-introduced
  reds before review, pre-existing and unattributable reds route to reviewer diagnosis, and
  fix-turn accounting is durable across resumed sessions, including orphan-job detection and
  explicit lifecycle states for every isolated hand-back outcome
- Provision isolated worktrees symlink-first so their gates run natively, with main-toolchain
  fallback recipes and per-gate provenance (native, main toolchain, or not run) when provisioning
  is impossible
- Extend tournament contestants with the same shell-capable, worktree-targeted conduct and
  provisioning, label their self-reported checks distinctly from orchestrator gates, and review
  contestants concurrently under a Codex-routed reviewer
- Add common runner families (npx, pnpm, yarn, dotnet, cargo, go, make, python3, pytest, mvn,
  gradle) to the implementation commands' allowed tools, and trim Quick's inline scope gate to a
  size check so the routed planner no longer duplicates its exploration

## 1.43.0

- Compare two stored plan slots: `plan-state --compare <slotA> <slotB>` (surfaced through
  `/stereo:plan-state`) renders both slots' review metadata side by side plus a unified line diff
  of the stored plan texts from a new dependency-free capped LCS — per-side preflights (2000
  effective lines, one million UTF-16 code units) run before any allocation-scale work, an empty
  side normalizes to zero lines, and the hunk format is pinned byte-exactly by tests. The JSON
  payload is metadata-only; each full plan stays reachable per slot via `--json --slot` or
  `--open`
- Complete the alternating-vendor defaults at the build seats: `claude:opus` implements in the
  contained file-edit agent and `codex:sol` gates the diff, so every handoff crosses ecosystems —
  Claude plans and builds, Codex challenges the plan and gates the diff
- Make the implementer resolution honest under any model mix: stored-plan and plan-review payload
  models never resolve the implementer (explicit flag > workspace default > built-in), a Codex
  implementer resumes the stored review thread only when it is the model that produced it, a
  same-model implementer/reviewer pairing from the built-in default substitutes the other
  ecosystem's review gate (explicit or workspace-configured self-review is honored but called
  out), and `--fresh` is reported as inert for a Claude-routed implementer

## 1.42.0

- Flip the built-in role defaults to alternate vendors at every handoff: `claude:fable` drafts
  the plan, `codex:sol` reviews it, `codex:sol` implements on the stored review thread, and
  `claude:fable` gates the diff — for `/stereo:plan`, `/stereo:implement`, and `/stereo:quick`
  alike (quick's scope gate stays inline). Driven by a five-combo planning benchmark on identical
  drafts: the Codex reviewer verified plan claims empirically — running boundary cases instead of
  reading past them — and found defects every same-family reviewer missed, while `claude:fable`
  produced the judged-best draft
- The default plan review now stores each parsed round durably with a resumable `plan-review`
  thread, so implementation resumes the approval context instead of starting fresh; one flag
  (`--plan-reviewer claude:fable`) restores the faster all-Claude plan loop
- Update every consequence claim to the new mechanics — budget split, thread resumption, escape
  hatches, the strategy rationale, the marketing site's step cards, schematic, configurator, and
  model matrix — and drop effort annotations on defaults wherever the effort is just the model's
  pair default

## 1.41.0

- Bring `/stereo:quick` to flag parity with the phase commands: `--slot <name>` targets a named
  durable plan slot with `<slotArg>` threaded onto all five slot-scoped companion invocations —
  including Quick's two `plan-review` launches, which store each parsed round durably and would
  otherwise overwrite the `default` slot under a Codex plan reviewer while the warning named the
  selected slot — with the existing-plan notice retargeted to the selected slot and deliberately
  kept warn-only
- Make both pause points configurable: `--max-plan-rounds <n>` (default 2, rejected above Quick's
  fixed absolute safeguard of 6) and `--max-fix-rounds <n>` (default 2), with cap-relative pause
  and keep-iterating wording in the command and README
- Add `--isolated`: implementation, implementation review, and fixes run in a throwaway detached
  worktree via the same machinery as `/stereo:implement --isolated`, minus durable state — Quick
  keeps no implementation record, so the worktree path is printed at creation and
  `/stereo:doctor`'s stranded-worktree listing is the crash mitigation; the plan draft and plan
  review always run against the main tree, and the implemented marker is set only after an
  applied or empty patch
- Pin the new wiring structurally: the four flags in the argument hint, the `<slotArg>` idiom,
  both `plan-review` launch lines, and all four `<isolationArgs>` launch lines

## 1.40.0

- Inspect and cancel jobs across workspaces: `status`, `result`, and `cancel` accept
  `--workspace <path>` so runs recorded against another repository root — as isolated
  implementations and tournaments write them — have a first-class inspect and cancel path, with
  cancel retargeting its broker interrupt accordingly
- Persist what a task actually did: bounded command executions (output tails only for failing
  commands) and file changes (paths and kinds, never diffs) are stored with each task job and
  exposed by `result --json`, while the human-rendered output stays byte-identical
- Accept focus text on `/stereo:review`'s Claude route as fenced untrusted steering, ending a
  needlessly propagated Codex-only limitation; the Codex route keeps its built-in-reviewer
  rejection
- Consolidate the authored and runtime surfaces: implementer-payload contracts normalized to one
  wording across implement/quick/tournament and pinned by line-anchored tag counts, the
  `codex-result-handling` skill finally declared by the rescue agent with a verbatim-return
  precedence rule (and the never-auto-apply rule carried into `result.md`), twelve duplicated
  helpers absorbed into a new shared JSON module with dead helpers deleted, terminal-status sets
  and JSON-RPC error construction single-sourced, pid-liveness paths unified only where semantics
  match (deliberate inversions documented in place), and `/stereo:doctor` now reporting the
  tournament record beside the implementation record

## 1.39.0

- Make tournaments durable and resumable: a new `tournament-state` companion subaction keeps a
  per-workspace record (contestants merged by label, plan-fingerprint snapshot with drift
  detection, bounded summaries under the same 512 KiB rule as the implementation record), the
  tournament records every phase transition into it, and `/stereo:tournament --resume` re-enters
  an interrupted run by recorded contestant status — with honest limits: Codex contestants
  recover from their durable jobs, a Claude contestant that already started is judged on its
  worktree delta only, and a mandatory delta guard prevents re-invoking any contestant whose
  worktree shows work regardless of its recorded status
- Let the workspace `implementer` default supply the default lineup's first seat when it is valid
  and Codex-routed (falling back to `codex:sol`), with the pre-launch announcement naming which
  source supplied it
- Mark the stored plan implemented automatically after a fully successful hand-back — acceptable
  winner, clean apply, and all main-tree gates green — ending the follow-up friction of an
  implemented-in-fact but unmarked plan, while tournaments still never write the implementation
  record

## 1.38.0

- Add `/stereo:doctor`, a diagnostics command for workspace state that previously had no
  inspection surface: the broker record with pid/endpoint liveness probes and the `broker.log`
  path, the resolved durable state directory, an in-progress implementation record with its
  `/stereo:implement --resume` pointer, stranded `stereo-worktrees` entries with exact removal
  commands, the SessionStart announcement watermark with a `--reset-job-announcements` repair,
  and a model-catalog drift check comparing the registry's OpenAI rows against the Codex CLI's
  local catalog cache (the check that would have caught the retired spark model months earlier)
- Fail fast at job launch: a shared preflight verifies Codex availability and authentication
  before any job record is created on `task`, `review`, and `plan-review` alike, replacing the
  raw mid-job auth error with a pinned "run `codex login`" message and ending the spurious
  running-then-failed records the foreground review paths could write
- Guard the session hooks against Node older than 24: CommonJS shims explain the requirement
  (SessionStart relays it into the session; Stop fails open) instead of failing with a raw
  `.ts` loader error, delegating to the TypeScript entries via an exported `main()`; the fake
  Codex fixture now keys stale-write-escalation on write-sandbox resume attempts so the scenario
  stays meaningful across broker-backed and endpoint-pinned flows

## 1.37.0

- Rename the `spark` alias to `mini`, now resolving to `gpt-5.4-mini`: the previous
  `gpt-5.3-codex-spark` id is retired upstream (absent from the Codex CLI's shipped model catalog
  and marked unsupported for API use, so it only appeared to work because unregistered ids pass
  through unchanged). The row pins its default pair effort at `xhigh` — a live probe showed the
  model rejects `max` — and the routing skill's effort ladder now resolves per-model registry
  defaults instead of assuming `max` for every `gpt-*` model. There is no back-compat `spark`
  alias: a stored `codex:spark` workspace default or habit now passes `spark` through as a
  literal unknown model id and fails when the job starts
- Update the `glm` alias from `glm-5.1` to `glm-5.2`, the current Z.AI flagship; its effort
  default deliberately stays unset pending verification of how the Codex CLI forwards reasoning
  effort to OpenAI-compatible custom providers
- Bump the pinned Codex CLI in CI from 0.145.0 to 0.146.0 on both lanes, with codegen and
  typecheck compatibility verified against the new version; `sol`, `terra`, `luna`, `kimi`,
  `deepseek`, and `qwen` were audited against upstream and remain current and unchanged

## 1.36.0

- `/stereo:tournament` now selects the winner automatically when the review evidence is decisive:
  exactly one acceptable contestant wins outright, byte-identical acceptable deltas win by lowest
  label, and the selection question remains only for genuine ambiguity (multiple differing
  acceptable deltas, or none acceptable); a decisively selected winner is auto-applied when no
  patched path overlaps a dirty path, `HEAD` has not moved, and the 3-way pre-check passes, host
  gates now run after any successful apply, and the final report names which decisiveness rule
  fired
- `/stereo:review` gains a first-class Claude route: `claude:session`, `claude:inherit`, and the
  four named aliases run a standard implementation-quality review in the foreground through the
  new `stereo:reviewer` agent and review prompt, validated against the same `review-output`
  schema as `/stereo:adversarial-review`, while Codex selections keep the built-in reviewer,
  `--background` stays Codex-only, and custom focus text is rejected on both routes
- Restructure `commands/review.md` to mirror `adversarial-review.md` section for section, add the
  routing skill's sixth foreground-agent template, and update the structural test pins and the
  README's helper count, deliberate boundaries, and route-parity table coordinately

## 1.35.0

- Add a `version` subcommand to the companion CLI: `codex-companion.ts version` prints the running
  plugin copy's version from its shipped manifest as plain text, `--json` emits
  `{"version": "<semver>"}`, and failures (an unreadable or malformed manifest, stray positionals)
  flow through the established compact `{"error"}` contract with exit code 1
- Read the plugin manifest in one place: a new strict shared reader backs the subcommand, and the
  transport's `readPluginVersion` now delegates to it while keeping its soft `0.0.0` fallback so
  app-server initialization can never hard-fail
- Pin the new surface with spawn-based tests covering the output shapes, the help listing, the
  error contract, and the reader's fail-closed messages, with the new test file classified in the
  Windows-lane bookkeeping

## 1.34.2

- Reject bare `claude:*` selections at the companion model boundary: `normalizeRequestedModel`
  now fails fast with a pinned error naming Codex selections as the only accepted `--model`
  values, so `task`, `plan-review`, `review`, and `adversarial-review` reject a Claude route
  before creating any job record instead of forwarding it to Codex as a literal model id that
  fails late; `codex:claude:*` keeps its existing distinct error, and role-default parsing is
  unaffected because it resolves `claude:*` before this guard
- Document the deliberate one-runtime surfaces so every asymmetry is stated rather than
  accidental: the model-routing skill carries one canonical sentence for the inert command-wide
  `--effort` (repeated verbatim by `implement`, `quick`, and `tournament`), `/stereo:rescue`
  rejects `claude:*` with named alternatives, `/stereo:review` and `/stereo:transfer` state
  their single-runtime boundaries, and the README gains a route-parity table under Deliberate
  boundaries
- Pin the new behavior in tests: the exact rejection message across prefix variants (with
  provider-qualified ids still passing), CLI fail-fast with a `{"error"}` envelope and no job
  record leaked, and a `claude:*` round-trip through all four `/stereo:config` roles

## 1.34.1

- Allow Claude Code models as tournament contestants: the four named `claude:*` aliases and
  `claude:inherit` run as foreground `stereo:implementer` agents confined to their own detached
  worktrees, launched after the Codex contestants' concurrent background jobs; a denied or failed
  Claude contestant is withdrawn (worktree retained) instead of aborting the tournament, and the
  main-tree containment guard additionally runs after each Claude contestant returns
- Give `/stereo:tournament` a built-in default lineup: with no `--implementer` flags it races
  `codex:sol` at its `max` pair default against `claude:opus` at full session strength;
  `--implementer-effort` becomes Codex-only (the shared `--effort` covers Codex contestants in
  mixed lineups, and Claude contestants report their effort as not applicable)

## 1.34.0

- Add `/stereo:tournament`: race two or three independent Codex implementers on the same approved
  stored plan, each in its own throwaway detached git worktree, with staggered launches against the
  shared workspace broker and a single relaunch on a transient busy rejection
- Review every contestant's delta independently against the plan (no cross-contestant context),
  present a comparison table of verdicts, diffstats, and per-invocation usage, and let the user
  pick the winner; the winning delta lands through the existing user-confirmed `git apply --3way`
  patch flow while losing deltas are preserved as patch files
- Keep tournaments stateless by design: no durable implementation record, no `--resume`, the plan
  is never marked implemented, and host gates run once in the main tree after a confirmed
  hand-back

## 1.33.0

- Add file-based `plan-store` metadata: `--summary-file`, `--open-questions-file`, and
  `--residual-risks-file` mirror `--findings-file` (same containment, validation, and
  validate-before-write ordering) so paragraph-length model text never passes through shell
  quoting; supplying both the inline and file form of a field is a hard error, and every command
  surface that emits a `plan-store` invocation now uses the file form
- Add `result <id> --report` to print just the stored implementer report, with a compact
  `jobId`/`status`/`report`/`threadId`/`tokenUsage` JSON envelope under `--json` instead of the
  full stored-job envelope
- Merge `implement-state --update`/`--complete` `rounds[]` entries by their `review` number
  (`round` accepted as a legacy alias) instead of appending, so resending a round is idempotent
  and previously duplicated entries self-heal on the next update

## 1.32.0

- Add named plan slots: stored plans live in per-slot durable files selected with `--slot <name>`
  on `plan-review`, `plan-store`, `plan-state`, and `implement-state --record`, while the default
  slot keeps today's `pair-plan.json`/`pair-plan.md` byte-for-byte so existing invocations,
  payloads, and rendered output are unchanged and no migration runs
- Add `plan-state --list` to inventory every slot (marking the one the implementation record
  belongs to), scope `--open`, `--clear`, and `--mark-implemented` by slot, and remove the
  implementation record on clear only when it was made from the cleared slot
- Snapshot the slot in the implementation record so `/stereo:implement --resume` re-reads the
  right plan, and let `/stereo:implement --slot <name>` pick the stored plan to implement
- Guard `/stereo:plan` with a single overwrite question when a content-storing run targets a slot
  whose plan was never implemented, replacing the old `--plan-file` intake confirmation; plain
  `--review-only` never asks

## 1.31.1

- Fix the two Windows CI lane test failures from the v1.31.0 run: `createBrokerEndpoint` now
  builds its unix socket path with `path.posix.join` (a Windows host asking for a non-win32
  endpoint previously got backslashes), and the test fixture `makeTempDir` returns the
  canonicalized (`fs.realpathSync.native`) temp directory so the runners' 8.3 short-form paths
  never enter comparisons
- Canonicalize `resolveContainedUserFile`'s candidate and allowed roots with
  `fs.realpathSync.native` as well, keeping file containment consistent with long-form paths and
  making short-form user input work on Windows

## 1.31.0

- Add worktree-isolated implementation via `/stereo:implement --isolated`: the implementer works in
  a throwaway detached git worktree under the OS temp directory, a new `--workspace` flag with a
  broker-cwd split keeps durable state, job records, and the single shared workspace broker in the
  main repository, review and host gates target the worktree, and the delta is handed back as a
  user-confirmed `git apply --3way` patch — never a commit
- Bound every CLI stdin read: piped input gets an idle deadline (`CODEX_STDIN_TIMEOUT_MS`, default
  10s), a 32 MiB cap, and pinned actionable errors instead of hanging forever on a never-closing
  pipe or crashing with raw `EAGAIN` on a non-blocking one; hook stdin stays synchronous and
  degrades to empty
- Confine user-supplied file flags (`--prompt-file`, `--plan-file`, `--findings-file`,
  `--output-schema`) to the workspace, OS temp directory, and plugin roots with a 16 MiB size cap
- Make the advisory Windows CI lane real: `.gitattributes` pins LF endings, `npm run test:windows`
  runs the portable test subset plus a win32 named-pipe round trip and a lane drift guard, and a
  written promotion criterion replaces the known-red lane
- Harden runtime edges: git-collection and stop-gate output buffers with friendly `ENOBUFS`
  errors, guarded plugin-manifest, session-ledger, and legacy-migration reads with one-shot
  diagnostics, a fixed post-spawn pid write race, and `plan-state --clear` now also clearing the
  implementation record
- Prescribe the rendered foreground status poll and a model-carrying malformed-output retry in the
  routing skill, with matching command-doc fixes (`setup` gains `disable-model-invocation`;
  `cancel`, `status`, and `plan` wording corrected)

## 1.30.0

- Add durable workspace-scoped implementation-phase records and `/stereo:implement --resume`,
  including recorded background-job recovery, plan-fingerprint drift detection, and bounded round
  summaries
- Add review ergonomics with prompted adversarial-review effort control and named-model pair-effort
  defaults, an explicit native-review effort rejection, standalone implementation review against
  `--base <ref>`, and user-side `--pr <n>` resolution without worktree mutation
- Add `/stereo:status --usage` for local retained-job token totals grouped by job kind and model,
  with session/workspace scopes and JSON output

## 1.29.0

- Add durable per-workspace model and Codex effort defaults for the four pair roles, with the new
  `/stereo:config` command, tolerant validation, JSON and rendered reports, and explicit precedence
  across plan, implement, and quick workflows
- Add external plan intake through `/stereo:plan --review-only --plan-file`, confirmed plan-state
  clearing, and an `implementedAt` lifecycle marker set after a full accepted implementation phase
- Announce active and newly finished durable background jobs at SessionStart using local state
  only, while keeping fresh and jobless workspaces silent and making announcement failures harmless
- Improve plugin directory presentation with the `Claudex Stereo` display name and expand setup
  into a report-backed first-run happy path

## 1.28.0

- Close the job-index write race: `saveState` now merges per job id with absorbing terminal
  statuses (a terminal record is never replaced by a non-terminal one), and `/stereo:result`
  repairs a stale running row from the authoritative per-job file instead of failing forever
- Gate every disk-sourced-pid kill on process liveness in `/stereo:cancel` and the SessionEnd
  sweep, and terminalize the cancelled record even when signal delivery fails, so a recycled pid
  can no longer receive a stray process-group SIGTERM after a reboot
- Add env-tunable deadlines to the Codex transport: per-request and broker-connect timeouts plus
  an inactivity-based turn deadline, so a wedged app-server fails the job and releases its thread
  reservation instead of stranding a detached worker forever
- Retry a busy shared broker on a direct app-server only when no request was dispatched yet,
  preventing replays after real side effects, and automatically reap reservation-cleanup claims
  whose owning process is dead instead of requiring a manual removal
- Make `review --background` a real detached job with `/stereo:status`/`/stereo:result`
  integration and reject it alongside `--wait`; validate job-id shapes before deriving paths;
  write `broker.json` atomically; record spawn failures as failed jobs instead of crashing; and
  cap untracked-file inlining under an aggregate review byte budget
- Break the module graph's only upward edge by moving the broker wire constants into
  `protocol/broker-rpc.ts` and injecting the transport client from the broker entry script, with
  a new layering test enforcing downward-only imports
- Preserve stored plan `threadId`/`model`/`effort` across Claude-side `plan-store` persists via
  explicit `--thread`/`--no-thread`, bound turn-capture accumulation (drop the dead message
  transcript, cap notification-error samples), and surface a `droppedNotifications` count in job
  results so silent capture loss becomes visible
- Fail `/stereo:setup`'s ready flag on Node majors below 24 with an actionable upgrade step;
  fence untrusted content (diffs, implementer reports, host output, embedded plan documents) as
  data-not-instructions in all three review prompts; and make the implementation-review output
  contract self-contained
- Define the planner/reviewer selection placeholders in the plan and quick commands so a Codex
  planner cannot silently lose its effort default, grant the implement and quick commands the
  `Edit` and `Bash(npm:*)` tools their own gates require, apply one quoted `$ARGUMENTS`
  convention across all companion invocations, disable model invocation of `/stereo:rescue`, and
  make the rescue subsystem coherent (readable skill references, satisfiable background
  ownership, an actionable failure line)

## 1.27.0

- Adopt the codex: prefix as the written form for every Codex-side model selection across the
  docs, command prompts, site, and orchestrator reports, symmetric with claude:; the runtime
  accepts bare forms unchanged and keeps resolved model ids in storage and output, and setup's
  per-alias readiness lines now print the prefixed alias
- Add the claudex-stereo.com marketing site under docs/ for GitHub Pages: a single
  self-contained static page with the workflow walkthrough, feature grid, routing table, command
  reference, and a labeled schematic session; no external requests, CNAME and .nojekyll included
- Rebuild the page light-first around the mockup direction as a full project overview: the
  two-column Claude/Codex channel diagram, a twelve-command reference, an interactive routing
  console with the per-role defaults table, typical flows, an FAQ, honest feature and
  credibility rows, and the schematic pair session, with every claim checked against the
  shipped commands and README
- Add a 404 page, robots.txt, sitemap.xml, a rendered social-preview image with large-card
  metadata, and structural site tests guarding README anchors, install commands, and the page's
  no-external-request property
- Skip CI on docs-only pushes via paths-ignore while keeping full CI on pull requests

## 1.26.3

- Document the public GitHub marketplace install (`vsladkov/claudex-stereo`) as the primary
  install path, keeping the local-checkout path as the alternative
- Add repository, homepage, and issues metadata to the package and a CI badge to the README

## 1.26.2

- Run CI on pushes to main and manual dispatch, not only pull requests, and rename the workflow
  to CI accordingly
- Pin the CI Codex CLI install to the locally verified version so upstream releases cannot break
  unrelated runs; bump the pin when upgrading Codex
- Add the package author and remove two empty stray directories from the repository root

## 1.26.1

- State the pairing accurately: the plugin pairs the Claude Code and Codex harnesses with an
  independent model choice for every role, not two fixed models; the manifest descriptions now
  say mixed-model
- Lead the README with the plugin's own work: the fork/attribution blockquote moves from the top
  into the License section, and the intro names the broker runtime, background jobs, thread
  reservations, and review gate

## 1.26.0

- Restructure the README around a getting-started arc: new Contents, Quick start with a real
  status transcript, Troubleshooting, and a Model routing reference that consolidates the
  routing doctrine out of the command path
- Merge `/stereo:status`, `/stereo:result`, and `/stereo:cancel` into one Background jobs
  section and collapse the five scattered reviewer-continuation statements into a single
  Reviewer continuation reference with per-command cross-links
- Deduplicate per-command addressing and scope restatements, cut dogfood version history from
  the model-choice guidance, and consolidate the four cost passages into one route/budget/cost
  table

## 1.25.1

- Add the fork's own copyright line to both NOTICE copies while retaining the required upstream
  OpenAI attribution for `openai/codex-plugin-cc`
- Add a README License section naming Apache-2.0 and pointing at LICENSE and NOTICE

## 1.25.0

- Document the built-in Codex alias mappings, pair-role effort defaults, pinned role pipeline, and
  named Claude model availability required by the default path
- Document review scope selection, session-aware status flags, and the complete setup readiness
  report
- Correct Quick's reviewer-neutral continuation behavior and round-6 safeguard, and explain why
  Codex implementation-review rounds remain fresh
- Complete the contributor surface, fix the installed plan-review schema path, and broaden the
  rescue prompting guidance to all Codex CLI models

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
