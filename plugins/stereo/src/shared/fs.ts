import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function ensureAbsolutePath(cwd: string, maybePath: string): string {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = 'codex-plugin-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function safeReadFile(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

export function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  return fs.readFileSync(0, 'utf8');
}

export function readStdinJsonIfPiped(): Record<string, unknown> {
  // Hook stdin is untrusted: malformed (or unreadable) input must degrade to
  // empty input, never throw. Throwing exits nonzero before any decision,
  // which Claude Code treats as a non-blocking hook error - that silently
  // bypasses an enabled Stop gate and skips SessionEnd job/broker cleanup.
  let raw: string;
  try {
    raw = readStdinIfPiped().trim();
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
