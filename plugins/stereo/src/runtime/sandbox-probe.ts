import { binaryAvailable } from '../platform/process.ts';
import type { BinaryAvailability } from '../platform/process.ts';

export const CODEX_SANDBOX_USAGE_ERROR =
  /unrecognized subcommand|unexpected argument|required arguments were not provided|requires a .?\[permissions\].? table|invalid value|unknown built-in profile|unknown permission profile|permission profile .* not found/i;

export type WriteSandboxProbe = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => BinaryAvailability;

export interface WriteSandboxProbeOptions {
  platform?: NodeJS.Platform;
  probeImpl?: WriteSandboxProbe;
}

export interface WriteSandboxStatus {
  available: boolean | null;
  detail: string;
}

export function getCodexWriteSandboxStatus(
  cwd: string,
  options: WriteSandboxProbeOptions = {},
): WriteSandboxStatus {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return { available: null, detail: 'not probed on Windows' };
  }

  const probeImpl = options.probeImpl ?? binaryAvailable;
  const primary = probeImpl('codex', ['sandbox', '-P', ':workspace', '--', 'true'], { cwd });
  if (primary.available) {
    return { available: true, detail: 'workspace-write sandbox launches' };
  }
  if (!CODEX_SANDBOX_USAGE_ERROR.test(primary.detail ?? '')) {
    return { available: false, detail: primary.detail };
  }

  const fallback = probeImpl(
    'codex',
    ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'true'],
    { cwd },
  );
  if (fallback.available) {
    return { available: true, detail: 'workspace-write sandbox launches' };
  }
  if (!CODEX_SANDBOX_USAGE_ERROR.test(fallback.detail ?? '')) {
    return { available: false, detail: fallback.detail };
  }

  return {
    available: null,
    detail: `write-sandbox probe unsupported by this Codex version: ${fallback.detail}`,
  };
}
