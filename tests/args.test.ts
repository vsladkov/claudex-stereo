import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/stereo/src/shared/args.ts";

test("parseArgs separates value options, boolean options, and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--model", "sol", "--json", "describe", "the", "task"],
    { valueOptions: ["model"], booleanOptions: ["json"] }
  );
  assert.deepEqual(options, { model: "sol", json: true });
  assert.deepEqual(positionals, ["describe", "the", "task"]);
});

test("parseArgs resolves aliases for long and short flags", () => {
  const { options } = parseArgs(["-m", "spark", "--bg"], {
    valueOptions: ["model"],
    booleanOptions: ["background"],
    aliasMap: { m: "model", bg: "background" }
  });
  assert.deepEqual(options, { model: "spark", background: true });
});

test("parseArgs supports inline values and boolean =false", () => {
  const { options } = parseArgs(["--model=gpt-5.4", "--json=false", "--wait=true"], {
    valueOptions: ["model"],
    booleanOptions: ["json", "wait"]
  });
  assert.deepEqual(options, { model: "gpt-5.4", json: false, wait: true });
});

test("parseArgs throws on missing values for both flag forms", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value for --model/);
  assert.throws(
    () => parseArgs(["-m"], { valueOptions: ["model"], aliasMap: { m: "model" } }),
    /Missing value for -m/
  );
});

test("parseArgs treats unknown flags, lone dash, and post -- tokens as positionals", () => {
  const { options, positionals } = parseArgs(["--unknown", "-", "--", "--model", "raw"], {
    valueOptions: ["model"]
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--unknown", "-", "--model", "raw"]);
});

test("splitRawArgumentString honors quotes, escapes, and whitespace runs", () => {
  assert.deepEqual(splitRawArgumentString("--model sol run the   task"), [
    "--model",
    "sol",
    "run",
    "the",
    "task"
  ]);
  assert.deepEqual(splitRawArgumentString("fix 'the broken thing' \"in one\" pass"), [
    "fix",
    "the broken thing",
    "in one",
    "pass"
  ]);
  assert.deepEqual(splitRawArgumentString("escaped\\ space and\\\"quote"), ["escaped space", 'and"quote']);
  assert.deepEqual(splitRawArgumentString("trailing\\"), ["trailing\\"]);
  assert.deepEqual(splitRawArgumentString("   "), []);
});
