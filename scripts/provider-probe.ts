#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { isMainModule } from '../plugins/stereo/src/shared/is-main.ts';
import type { TurnStartParams } from '../plugins/stereo/src/protocol/app-server.ts';
import { CodexAppServerClient } from '../plugins/stereo/src/transport/app-server-client.ts';
import { buildTurnInput, startThread } from '../plugins/stereo/src/runtime/threads.ts';
import { captureTurn } from '../plugins/stereo/src/runtime/turn-capture.ts';

export interface ProviderProbeOptions {
  configPath: string;
  model: string;
  live: boolean;
}

export interface ProviderStanza {
  providerId: string;
  envKey: string | null;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run provider-probe -- --config <stanza.toml> --model <id> [--live]',
    '',
    'The stanza must contain exactly one [model_providers.<id>] table and',
    'must set wire_api = "responses". --live also exercises a tool-using',
    'turn and a follow-up turn against the configured endpoint.',
  ].join('\n');
}

export function parseProviderProbeArgs(
  argv: readonly string[],
): ProviderProbeOptions & { help: boolean } {
  let configPath: string | null = null;
  let model: string | null = null;
  let live = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--config requires a TOML snippet path.');
      }
      configPath = value;
      index += 1;
    } else if (arg === '--model') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--model requires a model id.');
      }
      model = value;
      index += 1;
    } else if (arg === '--live') {
      live = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!help && !configPath) {
    throw new Error('--config is required.');
  }
  if (!help && !model?.trim()) {
    throw new Error('--model is required.');
  }

  return {
    configPath: configPath ? path.resolve(configPath) : '',
    model: model?.trim() ?? '',
    live,
    help,
  };
}

function parseTomlStringAssignment(lines: readonly string[], key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      return match[2] ?? '';
    }
  }
  return null;
}

export function parseProviderStanza(contents: string): ProviderStanza {
  const lines = contents.split(/\r?\n/);
  const tablePattern =
    /^\s*\[model_providers\.(?:([A-Za-z0-9_-]+)|"([^"\\]+)"|'([^']+)')\]\s*(?:#.*)?$/;
  const tables = lines.flatMap((line, index) => {
    const match = line.match(tablePattern);
    const providerId = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
    return providerId ? [{ providerId, index }] : [];
  });

  if (tables.length !== 1) {
    throw new Error(
      `Expected exactly one [model_providers.<id>] table in the stanza; found ${tables.length}.`,
    );
  }

  const table = tables[0] as { providerId: string; index: number };
  const nextTableOffset = lines.slice(table.index + 1).findIndex((line) => /^\s*\[/.test(line));
  const endIndex = nextTableOffset === -1 ? lines.length : table.index + 1 + nextTableOffset;
  const providerLines = lines.slice(table.index + 1, endIndex);
  const wireApi = parseTomlStringAssignment(providerLines, 'wire_api');
  if (wireApi !== 'responses') {
    throw new Error(
      `Provider "${table.providerId}" must set wire_api = "responses"; found ${wireApi ? JSON.stringify(wireApi) : 'no wire_api setting'}.`,
    );
  }

  const envKey = parseTomlStringAssignment(providerLines, 'env_key');
  return {
    providerId: table.providerId,
    envKey: envKey || null,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildProviderProbeConfig(
  stanza: string,
  model: string,
  providerId: string,
): string {
  return [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(providerId)}`,
    '',
    stanza.trim(),
    '',
  ].join('\n');
}

function assertCompletedTurn(label: string, state: Awaited<ReturnType<typeof captureTurn>>): void {
  if (state.error) {
    const message =
      typeof state.error === 'object' && state.error && 'message' in state.error
        ? String((state.error as { message: unknown }).message)
        : String(state.error);
    throw new Error(`${label} failed: ${message}`);
  }
  if (state.finalTurn?.status !== 'completed') {
    const turnError = state.finalTurn?.error;
    const detail = turnError
      ? `: ${typeof turnError === 'string' ? turnError : JSON.stringify(turnError)}`
      : '';
    throw new Error(`${label} ended with status ${state.finalTurn?.status ?? 'unknown'}${detail}.`);
  }
}

async function startProbeTurn(
  client: Awaited<ReturnType<typeof CodexAppServerClient.connect>>,
  threadId: string,
  model: string,
  prompt: string,
) {
  return captureTurn(client, threadId, () =>
    client.request('turn/start', {
      threadId,
      input: buildTurnInput(prompt),
      model,
      effort: null,
      outputSchema: null,
    } satisfies TurnStartParams),
  );
}

export async function runProviderProbe(
  options: ProviderProbeOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ providerId: string; live: boolean }> {
  const stanza = fs.readFileSync(options.configPath, 'utf8');
  const provider = parseProviderStanza(stanza);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-provider-probe-home-'));
  let scratch: string | null = null;
  let client: Awaited<ReturnType<typeof CodexAppServerClient.connect>> | null = null;

  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-provider-probe-workspace-'));
    const configPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(
      configPath,
      buildProviderProbeConfig(stanza, options.model, provider.providerId),
      'utf8',
    );
    fs.writeFileSync(
      path.join(scratch, 'provider-probe-marker.txt'),
      'STEREO_PROVIDER_PROBE_OK\n',
      'utf8',
    );
    const probeEnv: NodeJS.ProcessEnv = {
      ...env,
      CODEX_HOME: codexHome,
    };

    client = await CodexAppServerClient.connect(scratch, {
      disableBroker: true,
      env: probeEnv,
    });
    process.stdout.write(
      `Codex parsed the provider config for "${provider.providerId}" with model "${options.model}".\n`,
    );

    if (!options.live) {
      process.stdout.write(
        'Live endpoint check skipped; rerun with --live after setting the provider key.\n',
      );
      return { providerId: provider.providerId, live: false };
    }

    if (provider.envKey && !probeEnv[provider.envKey]) {
      throw new Error(
        `--live requires the ${provider.envKey} environment variable declared by provider "${provider.providerId}".`,
      );
    }

    const thread = await startThread(client, scratch, {
      model: options.model,
      modelProvider: provider.providerId,
      sandbox: 'read-only',
      ephemeral: true,
    });
    const threadId = thread.thread.id;
    const toolTurn = await startProbeTurn(
      client,
      threadId,
      options.model,
      'Use the shell command tool to read provider-probe-marker.txt. Do not answer until the command has run; then report the marker text.',
    );
    assertCompletedTurn('Tool-using probe turn', toolTurn);
    if (toolTurn.commandExecutions.length === 0) {
      throw new Error('Tool-using probe turn completed without an observed command execution.');
    }

    const followUp = await startProbeTurn(
      client,
      threadId,
      options.model,
      'This is the follow-up compatibility check. Reply briefly to confirm you retained the prior turn context.',
    );
    assertCompletedTurn('Follow-up probe turn', followUp);
    process.stdout.write(
      `Live provider probe passed for "${provider.providerId}" with model "${options.model}" (tool call plus follow-up).\n`,
    );
    return { providerId: provider.providerId, live: true };
  } finally {
    await client?.close().catch(() => {});
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const options = parseProviderProbeArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await runProviderProbe(options);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
