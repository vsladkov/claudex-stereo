# TypeScript migration notes

The JS-to-TS migration is complete: all runtime sources live under
`plugins/stereo/src/**/*.ts`, entry points under `plugins/stereo/scripts/*.ts`,
and every test under `tests/*.test.ts`. Node >= 24 runs the TypeScript
directly (native type stripping); there is no build or emit step.

## Parked state: review-4 design doc

The parked review-4 design doc (stored at its old scratchpad path) predates
this migration and cites the pre-migration `.mjs` module layout. When that
plan resumes, re-ground every file reference against `plugins/stereo/src/`
before acting on it:

| Old reference                         | Current location                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `lib/codex.mjs`                       | `src/runtime/*` (availability, auth, threads, turn-runner, turn-capture, reservations, structured-output, ...)   |
| `lib/state.mjs`                       | `src/workspace/state.ts`                                                                                         |
| `codex-companion.mjs` (companion CLI) | `src/cli/*` + `src/workflows/*` (thin entry: `scripts/codex-companion.ts`)                                       |
| hook scripts                          | `src/hooks/*` (thin entries: `scripts/stop-review-gate-hook.ts`, `scripts/session-lifecycle-hook.ts`)            |
| broker                                | `src/broker/server.ts` (thin entry: `scripts/app-server-broker.ts`; endpoint/lifecycle helpers in `src/broker/`) |
| `lib/job-control.mjs`                 | `src/jobs/job-control.ts`                                                                                        |
| `lib/tracked-jobs.mjs`                | `src/jobs/tracked-jobs.ts`                                                                                       |

Paths above are relative to `plugins/stereo/`.
