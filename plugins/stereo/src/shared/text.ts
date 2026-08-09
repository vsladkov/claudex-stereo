// Small cross-layer helpers shared by cli, workflows, and render. They live
// in shared/ so workflow modules never have to import from the cli layer.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shorten(text: unknown, limit = 96): string {
  const normalized = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function firstMeaningfulLine(text: unknown, fallback: string): string {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

export function outputResult(value: unknown, asJson: unknown): void {
  if (asJson) {
    // Compact on purpose: every consumer parses this (the orchestrating
    // model, tests), and 2-space indentation taxed large payloads with
    // ~15-30% pure-structure tokens. The error path is already compact.
    console.log(JSON.stringify(value));
  } else {
    process.stdout.write(value as string);
  }
}
