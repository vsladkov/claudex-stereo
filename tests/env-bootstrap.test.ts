import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.ts";
import { resolveStateDir } from "../plugins/stereo/src/workspace/state.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = path.join(ROOT, "tests", "env-bootstrap.cjs");
const STATE_MODULE_URL = pathToFileURL(
  path.join(ROOT, "plugins", "stereo", "src", "workspace", "state.ts")
).href;

test("preload strips leaked plugin variables", () => {
  const expression = [
    "CLAUDE_PLUGIN_DATA",
    "CODEX_COMPANION_SESSION_ID",
    "CODEX_COMPANION_TRANSCRIPT_PATH",
    "CLAUDE_ENV_FILE",
    "CLAUDE_PROJECT_DIR"
  ]
    .map((name) => `process.env.${name} ?? "unset"`)
    .join(",");
  const result = run(process.execPath, ["--require", BOOTSTRAP, "-p", `[${expression}].join(",")`], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: "/tmp/plugin-data",
      CODEX_COMPANION_SESSION_ID: "leaked-session",
      CODEX_COMPANION_TRANSCRIPT_PATH: "/tmp/transcript.jsonl",
      CLAUDE_ENV_FILE: "/tmp/session-env.sh",
      CLAUDE_PROJECT_DIR: "/tmp/project-dir"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "unset,unset,unset,unset,unset");
});

test("parent and child resolve the same state root under a polluted launcher", () => {
  const workspace = makeTempDir();
  const parentStateDir = resolveStateDir(workspace);
  const expression = `const { resolveStateDir } = await import(${JSON.stringify(STATE_MODULE_URL)}); console.log(resolveStateDir(${JSON.stringify(workspace)}));`;
  const result = run(process.execPath, ["--require", BOOTSTRAP, "--input-type=module", "-e", expression], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: "/tmp/poll"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const childStateDir = result.stdout.trim();
  assert.equal(childStateDir.startsWith(os.tmpdir()), true);
  assert.equal(childStateDir.startsWith(path.join("/tmp/poll", "state")), false);
  assert.equal(childStateDir, parentStateDir);
});
