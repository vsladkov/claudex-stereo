import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "./helpers.ts";
import { parseCommandInput, readUserFile, wasJsonRequested } from "../plugins/stereo/src/cli/io.ts";

// wasJsonRequested keeps module-level state: the raw-argv fallback applies
// only until the first parseCommandInput call in this process, so this test
// must run before any test below that parses.
test("wasJsonRequested scans the provided raw argv before any parse completes", () => {
  assert.equal(wasJsonRequested(["definitely-not-a-subcommand", "--json"]), true);

  // Slash commands pass all arguments as one raw string; the fallback splits
  // each token before looking for --json.
  assert.equal(wasJsonRequested(["task", "do the thing --json"]), true);

  assert.equal(wasJsonRequested(["task", "explain the json flag"]), false);
});

test("parseCommandInput separates value flags, boolean flags, and positionals", () => {
  const parsed = parseCommandInput(
    ["--model", "gpt-5.4-mini", "--background", "fix", "the", "bug", "--unknown-flag"],
    { valueOptions: ["model"], booleanOptions: ["background"] }
  );

  assert.equal(parsed.options.model, "gpt-5.4-mini");
  assert.equal(parsed.options.background, true);
  assert.deepEqual(parsed.positionals, ["fix", "the", "bug", "--unknown-flag"]);
});

test("parseCommandInput maps the C alias onto cwd", () => {
  const short = parseCommandInput(["-C", "/some/workspace", "status"], { valueOptions: ["cwd"] });
  assert.equal(short.options.cwd, "/some/workspace");
  assert.equal(short.options.C, undefined);
  assert.deepEqual(short.positionals, ["status"]);

  const long = parseCommandInput(["--C", "/alias/workspace"], { valueOptions: ["cwd"] });
  assert.equal(long.options.cwd, "/alias/workspace");

  const inline = parseCommandInput(["--cwd=/other/workspace"], { valueOptions: ["cwd"] });
  assert.equal(inline.options.cwd, "/other/workspace");
});

test("parseCommandInput splits a single raw argument string like a slash command", () => {
  const parsed = parseCommandInput(['--scope working-tree "focus on auth"'], {
    valueOptions: ["scope"]
  });

  assert.equal(parsed.options.scope, "working-tree");
  assert.deepEqual(parsed.positionals, ["focus on auth"]);
});

test("parseCommandInput keeps everything after -- as positionals", () => {
  const parsed = parseCommandInput(["run", "--", "--background"], {
    booleanOptions: ["background"]
  });

  assert.equal(parsed.options.background, undefined);
  assert.deepEqual(parsed.positionals, ["run", "--background"]);
});

test("wasJsonRequested is false post-parse when --json only appears inside prompt text", () => {
  // Multiple argv entries keep the prompt one positional token, exactly like
  // Bash invocations with a quoted prompt argument.
  const parsed = parseCommandInput(
    ["--prompt-file", "notes.md", "explain the --json flag"],
    { valueOptions: ["prompt-file"], booleanOptions: ["json"] }
  );
  assert.equal(parsed.options.json, undefined);
  assert.deepEqual(parsed.positionals, ["explain the --json flag"]);

  // Once parsing has completed, the raw-argv fallback must not resurrect a
  // --json that the parse classified as prompt text.
  assert.equal(wasJsonRequested(["task", "explain the --json flag"]), false);
});

test("wasJsonRequested is true post-parse only with a real --json option", () => {
  assert.equal(wasJsonRequested(), false);

  const parsed = parseCommandInput(["--json", "status"], { booleanOptions: ["json"] });
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.positionals, ["status"]);
  assert.equal(wasJsonRequested(), true);
});

test("readUserFile returns file contents resolved against cwd", () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "prompt.md"), "prompt body\n", "utf8");

  assert.equal(readUserFile(cwd, "--prompt-file", "prompt.md"), "prompt body\n");
});

test("readUserFile reports the flag name and resolved path when the read fails", () => {
  const cwd = makeTempDir();
  const resolved = path.resolve(cwd, "does-not-exist.md");

  assert.throws(
    () => readUserFile(cwd, "--prompt-file", "does-not-exist.md"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(`Could not read --prompt-file ${resolved}:`)
  );
});
