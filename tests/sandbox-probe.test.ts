import assert from "node:assert/strict";
import test from "node:test";

import { getCodexWriteSandboxStatus } from "../plugins/stereo/src/runtime/index.ts";
import type { BinaryAvailability } from "../plugins/stereo/src/platform/process.ts";

interface ProbeCall {
  command: string;
  args: readonly string[];
  options: { cwd: string };
}

const CWD = "/tmp/codex-sandbox-probe-workspace";
const PRIMARY_ARGS = ["sandbox", "-P", ":workspace", "--", "true"];
const FALLBACK_ARGS = ["sandbox", "-c", 'sandbox_mode="workspace-write"', "--", "true"];
const USAGE_FAILURE = { available: false, detail: "error: unexpected argument '-P'" };
const ABSENT_PROFILE_FAILURE = {
  available: false,
  detail: "Error: default_permissions refers to unknown built-in profile ':workspace'"
};
const BWRAP_FAILURE = {
  available: false,
  detail: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
};

function recordingProbe(results: BinaryAvailability[]) {
  const calls: ProbeCall[] = [];
  return {
    calls,
    probeImpl(command: string, args: readonly string[], options: { cwd: string }): BinaryAvailability {
      calls.push({ command, args, options });
      assert.notEqual(results.length, 0, "probe was invoked more times than expected");
      return results.shift()!;
    }
  };
}

function assertProbeCall(call: ProbeCall | undefined, expectedArgs: readonly string[]) {
  assert.ok(call);
  assert.equal(call.command, "codex");
  assert.deepEqual(call.args, expectedArgs);
  assert.deepEqual(call.options, { cwd: CWD });
}

test("write sandbox probe is inconclusive on Windows without spawning", () => {
  const status = getCodexWriteSandboxStatus(CWD, {
    platform: "win32",
    probeImpl() {
      throw new Error("probe should not run on Windows");
    }
  });

  assert.deepEqual(status, { available: null, detail: "not probed on Windows" });
});

test("write sandbox probe succeeds with the built-in workspace profile", () => {
  const probe = recordingProbe([{ available: true, detail: "ok" }]);
  const status = getCodexWriteSandboxStatus(CWD, { platform: "linux", probeImpl: probe.probeImpl });

  assert.deepEqual(status, { available: true, detail: "workspace-write sandbox launches" });
  assert.equal(probe.calls.length, 1);
  assertProbeCall(probe.calls[0], PRIMARY_ARGS);
});

test("write sandbox probe falls back to the legacy workspace-write override", () => {
  const probe = recordingProbe([USAGE_FAILURE, { available: true, detail: "ok" }]);
  const status = getCodexWriteSandboxStatus(CWD, { platform: "linux", probeImpl: probe.probeImpl });

  assert.deepEqual(status, { available: true, detail: "workspace-write sandbox launches" });
  assert.equal(probe.calls.length, 2);
  assertProbeCall(probe.calls[0], PRIMARY_ARGS);
  assertProbeCall(probe.calls[1], FALLBACK_ARGS);
});

test("write sandbox probe is inconclusive when both probe forms are unsupported", () => {
  const fallbackUsage = { available: false, detail: "error: unrecognized subcommand 'sandbox'" };
  const probe = recordingProbe([USAGE_FAILURE, fallbackUsage]);
  const status = getCodexWriteSandboxStatus(CWD, { platform: "linux", probeImpl: probe.probeImpl });

  assert.equal(status.available, null);
  assert.match(status.detail, /probe unsupported/i);
  assert.match(status.detail, /unrecognized subcommand/);
  assert.equal(probe.calls.length, 2);
});

test("write sandbox probe reports a primary sandbox launch failure without fallback", () => {
  const probe = recordingProbe([BWRAP_FAILURE]);
  const status = getCodexWriteSandboxStatus(CWD, { platform: "linux", probeImpl: probe.probeImpl });

  assert.deepEqual(status, BWRAP_FAILURE);
  assert.equal(probe.calls.length, 1);
  assertProbeCall(probe.calls[0], PRIMARY_ARGS);
});

test("write sandbox probe falls back when the built-in workspace profile is absent", () => {
  const probe = recordingProbe([ABSENT_PROFILE_FAILURE, { available: true, detail: "ok" }]);
  const status = getCodexWriteSandboxStatus(CWD, { platform: "linux", probeImpl: probe.probeImpl });

  assert.deepEqual(status, { available: true, detail: "workspace-write sandbox launches" });
  assert.equal(probe.calls.length, 2);
  assertProbeCall(probe.calls[1], FALLBACK_ARGS);
});

test("write sandbox probe reports a fallback sandbox launch failure", () => {
  const probe = recordingProbe([ABSENT_PROFILE_FAILURE, BWRAP_FAILURE]);
  const status = getCodexWriteSandboxStatus(CWD, { platform: "linux", probeImpl: probe.probeImpl });

  assert.deepEqual(status, BWRAP_FAILURE);
  assert.equal(probe.calls.length, 2);
  assertProbeCall(probe.calls[1], FALLBACK_ARGS);
});
