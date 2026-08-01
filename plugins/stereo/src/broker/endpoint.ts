import path from 'node:path';
import process from 'node:process';

export type BrokerEndpointKind = 'pipe' | 'unix';

export interface BrokerEndpointTarget {
  kind: BrokerEndpointKind;
  path: string;
}

function sanitizePipeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
}

export function createBrokerEndpoint(
  sessionDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-codex-app-server`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  // path.posix, not the host-bound path facade: this function is
  // platform-parameterized (the win32 branch above already uses path.win32),
  // so a Windows host asking for a non-win32 endpoint must still get a Unix
  // socket path with forward slashes.
  return `unix:${path.posix.join(sessionDir, 'broker.sock')}`;
}

export function parseBrokerEndpoint(endpoint: string): BrokerEndpointTarget {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('Missing broker endpoint.');
  }

  if (endpoint.startsWith('pipe:')) {
    const pipePath = endpoint.slice('pipe:'.length);
    if (!pipePath) {
      throw new Error('Broker pipe endpoint is missing its path.');
    }
    return { kind: 'pipe', path: pipePath };
  }

  if (endpoint.startsWith('unix:')) {
    const socketPath = endpoint.slice('unix:'.length);
    if (!socketPath) {
      throw new Error('Broker Unix socket endpoint is missing its path.');
    }
    return { kind: 'unix', path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
