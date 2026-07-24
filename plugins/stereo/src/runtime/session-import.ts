import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readJsonFile } from '../shared/fs.ts';
import type { ExternalAgentConfigImportParams, MigrationDetails } from '../protocol/app-server.ts';
import { getCodexAvailability } from './availability.ts';
import { resolveCodexHome } from './reservations.ts';
import { withDirectAppServer } from './threads.ts';
import type { AppServerClient } from './threads.ts';
import { emitProgress } from './turn-capture.ts';
import type { ProgressReporter } from './turn-capture.ts';
import { cleanCodexStderr } from './turn-runner.ts';

const EXTERNAL_AGENT_IMPORT_COMPLETED = 'externalAgentConfig/import/completed';
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

export interface ImportExternalAgentSessionOptions {
  sourcePath?: string | null;
  onProgress?: ProgressReporter | null;
}

export interface ImportExternalAgentSessionResult {
  threadId: string;
  stderr: string;
}

// Records in the import ledger are written by Codex; read them defensively.
interface ImportLedgerRecord {
  source_path?: string;
  content_sha256?: string;
  imported_thread_id?: string;
}

function sourceContentSha256(sourcePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
}

function importedThreadIdForSource(sourcePath: string): string | null {
  const ledgerPath = path.join(resolveCodexHome(), 'external_agent_session_imports.json');
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath) as { records?: unknown } | null;
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records: Array<ImportLedgerRecord | null | undefined> = Array.isArray(ledger?.records)
    ? ledger.records
    : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === 'string',
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(
  sourcePath: string,
  cwd: string,
): ExternalAgentConfigImportParams {
  // `skills` is deliberately absent from the details payload: the shipped
  // plugin never sent it and the server defaults it, so adding it here would
  // change the request bytes.
  const details: Omit<MigrationDetails, 'skills'> = {
    plugins: [],
    sessions: [{ path: sourcePath, cwd, title: null }],
    mcpServers: [],
    hooks: [],
    subagents: [],
    commands: [],
  };
  return {
    migrationItems: [
      {
        itemType: 'SESSIONS',
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: details as MigrationDetails,
      },
    ],
  };
}

async function requestExternalAgentSessionImport(
  client: AppServerClient,
  params: ExternalAgentConfigImportParams,
): Promise<void> {
  const previousHandler = client.notificationHandler;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(
      new Error('Timed out waiting for Codex to finish importing the Claude session.'),
    );
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request('externalAgentConfig/import', params);
    await completed;
  } finally {
    clearTimeout(timeout ?? undefined);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

export async function importExternalAgentSession(
  cwd: string,
  options: ImportExternalAgentSessionOptions = {},
): Promise<ImportExternalAgentSessionResult> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      'Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.',
    );
  }
  if (!options.sourcePath) {
    throw new Error('A Claude session source path is required.');
  }
  const sourcePath = options.sourcePath;

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, 'Importing Claude session into Codex.', 'transferring');
    try {
      await requestExternalAgentSessionImport(
        client,
        externalAgentSessionMigration(sourcePath, cwd),
      );
    } catch (error) {
      if ((error as { rpcCode?: number } | null | undefined)?.rpcCode === -32601) {
        throw new Error(
          'This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.',
          { cause: error },
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : ' Check the Codex app-server logs for the underlying import error.'}`,
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, 'completed', {
      threadId,
    });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr),
    };
  });
}
