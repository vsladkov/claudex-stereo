import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";

// CLAUDE_PROJECTS_DIR is derived from os.homedir() at module load, so the
// temp HOME must be exported before the module is imported.
const home = makeTempDir("transfer-home-");
process.env.HOME = home;
process.env.USERPROFILE = home;
const projectsDir = path.join(home, ".claude", "projects", "workspace");
fs.mkdirSync(projectsDir, { recursive: true });

const { resolveClaudeSessionPath } = await import("../plugins/stereo/scripts/lib/claude-session-transfer.mjs");

const IS_WINDOWS = process.platform === "win32";
const cwd = makeTempDir("transfer-cwd-");

test("resolveClaudeSessionPath expands ~ sources inside the projects dir", () => {
  const sessionFile = path.join(projectsDir, "session-a.jsonl");
  fs.writeFileSync(sessionFile, "{}\n", "utf8");

  const resolved = resolveClaudeSessionPath(cwd, {
    source: `~/${path.relative(home, sessionFile).split(path.sep).join("/")}`
  });
  assert.equal(resolved, fs.realpathSync(sessionFile));
});

test("resolveClaudeSessionPath rejects non-jsonl sources", () => {
  assert.throws(
    () => resolveClaudeSessionPath(cwd, { source: path.join(projectsDir, "notes.txt") }),
    /must be a JSONL file/
  );
});

test("resolveClaudeSessionPath reports a missing source with its error code", () => {
  assert.throws(
    () => resolveClaudeSessionPath(cwd, { source: path.join(projectsDir, "missing.jsonl") }),
    /Claude session file not found: .*missing\.jsonl \(ENOENT\)/
  );
});

test("resolveClaudeSessionPath rejects sources outside the projects dir", () => {
  const outside = path.join(home, "outside.jsonl");
  fs.writeFileSync(outside, "{}\n", "utf8");
  assert.throws(() => resolveClaudeSessionPath(cwd, { source: outside }), /only from/);
});

test(
  "a symlink inside the projects dir cannot escape it",
  { skip: IS_WINDOWS },
  () => {
    const secret = path.join(home, "secret.jsonl");
    fs.writeFileSync(secret, "{}\n", "utf8");
    const link = path.join(projectsDir, "escape.jsonl");
    fs.symlinkSync(secret, link);

    // realpath canonicalizes the symlink target, so the containment check
    // must reject it even though the lexical path sits under projects/.
    assert.throws(() => resolveClaudeSessionPath(cwd, { source: link }), /only from/);
  }
);

test("a broken projects dir is reported distinctly from a missing source", () => {
  const sessionFile = path.join(projectsDir, "session-b.jsonl");
  fs.writeFileSync(sessionFile, "{}\n", "utf8");

  const projectsRoot = path.join(home, ".claude", "projects");
  const movedAside = path.join(home, ".claude", "projects-moved");
  fs.renameSync(projectsRoot, movedAside);
  try {
    assert.throws(
      () => resolveClaudeSessionPath(cwd, { source: path.join(movedAside, "workspace", "session-b.jsonl") }),
      /Claude projects directory unavailable: .*projects \(ENOENT\)/
    );
  } finally {
    fs.renameSync(movedAside, projectsRoot);
  }
});
