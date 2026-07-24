import { BROKER_ENDPOINT_ENV } from "../transport/app-server-client.ts";
import { loadBrokerSession } from "../broker/lifecycle.ts";
import { binaryAvailable } from "../platform/process.ts";
import type { BinaryAvailability } from "../platform/process.ts";

export interface SessionRuntimeStatus {
  mode: "shared" | "direct";
  label: string;
  detail: string;
  endpoint: string | null;
}

export function getCodexAvailability(cwd: string): BinaryAvailability {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(
  env: NodeJS.ProcessEnv | null = process.env,
  cwd: string = process.cwd()
): SessionRuntimeStatus {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}
