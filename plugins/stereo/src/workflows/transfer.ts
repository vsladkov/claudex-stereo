import path from 'node:path';

import { importExternalAgentSession } from '../runtime/index.ts';
import { resolveClaudeSessionPath } from '../workspace/claude-session-transfer.ts';

export interface TransferPayload {
  threadId: string;
  resumeCommand: string;
  sourcePath: string;
  sessionId: string;
}

function renderTransferResult(payload: TransferPayload): string {
  const lines = [
    'Transferred the Claude session into a Codex thread with visible turn history.',
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`,
  ];
  return `${lines.join('\n')}\n`;
}

export interface ExecuteTransferOptions {
  source?: string;
}

export async function executeTransfer(
  cwd: string,
  options: ExecuteTransferOptions = {},
): Promise<{ payload: TransferPayload; rendered: string }> {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source,
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, '.jsonl'),
  };

  return {
    payload,
    rendered: renderTransferResult(payload),
  };
}
