import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseStructuredOutput, readOutputSchema } from "../plugins/stereo/src/runtime/structured-output.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS_DIR = path.join(ROOT, "plugins", "stereo", "schemas");

function expectedSyntaxErrorMessage(raw: string): string {
  try {
    JSON.parse(raw);
  } catch (error) {
    return (error as SyntaxError).message;
  }
  throw new Error(`Expected ${JSON.stringify(raw)} to be invalid JSON.`);
}

test("parseStructuredOutput parses valid JSON and preserves the raw output", () => {
  const raw = '{"verdict":"approve","findings":[]}';
  const result = parseStructuredOutput(raw);

  assert.deepEqual(result.parsed, { verdict: "approve", findings: [] });
  assert.equal(result.parseError, null);
  assert.equal(result.rawOutput, raw);
});

test("parseStructuredOutput reports the SyntaxError message for invalid JSON", () => {
  const raw = "not valid json";
  const result = parseStructuredOutput(raw);

  assert.equal(result.parsed, null);
  assert.equal(result.parseError, expectedSyntaxErrorMessage(raw));
  assert.equal(result.rawOutput, raw);
});

test("parseStructuredOutput falls back to the failureMessage when output is empty", () => {
  const result = parseStructuredOutput("", {
    status: 1,
    failureMessage: "Codex run failed before returning output."
  });

  assert.equal(result.parsed, null);
  assert.equal(result.parseError, "Codex run failed before returning output.");
  assert.equal(result.rawOutput, "");
  assert.equal(result.status, 1);
});

test("parseStructuredOutput uses the default message when output and failureMessage are missing", () => {
  for (const missing of [null, undefined, ""]) {
    const result = parseStructuredOutput(missing);
    assert.equal(result.parsed, null);
    assert.equal(result.parseError, "Codex did not return a final structured message.");
    assert.equal(result.rawOutput, "");
  }
});

test("a fallback carrying parsed/parseError/rawOutput keys never clobbers computed values", () => {
  const clobber = {
    status: 7,
    parsed: "stale-parsed",
    parseError: "stale-error",
    rawOutput: "stale-raw"
  };

  const success = parseStructuredOutput('{"ok":true}', clobber);
  assert.deepEqual(success.parsed, { ok: true });
  assert.equal(success.parseError, null);
  assert.equal(success.rawOutput, '{"ok":true}');
  assert.equal(success.status, 7);

  const failure = parseStructuredOutput("not json", clobber);
  assert.equal(failure.parsed, null);
  assert.equal(failure.parseError, expectedSyntaxErrorMessage("not json"));
  assert.equal(failure.rawOutput, "not json");
  assert.equal(failure.status, 7);

  const empty = parseStructuredOutput("", { ...clobber, failureMessage: "boom" });
  assert.equal(empty.parsed, null);
  assert.equal(empty.parseError, "boom");
  assert.equal(empty.rawOutput, "");
  assert.equal(empty.status, 7);
});

test("readOutputSchema reads the shipped review output schema", () => {
  const schema = readOutputSchema(path.join(SCHEMAS_DIR, "review-output.schema.json")) as Record<string, any>;

  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.ok(schema.properties.verdict);
});

test("readOutputSchema reads the shipped plan-review output schema", () => {
  const schema = readOutputSchema(path.join(SCHEMAS_DIR, "plan-review-output.schema.json")) as Record<string, any>;

  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, [
    "verdict",
    "summary",
    "findings",
    "revision_instructions",
    "open_questions",
    "residual_risks"
  ]);
  assert.ok(schema.properties.verdict);
});
