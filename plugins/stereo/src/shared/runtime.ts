// The two runtimes a companion job can run on. Records written before Claude
// jobs existed carry no runtime and count as Codex.
export type CompanionRuntime = 'claude' | 'codex';

// The runtime a job record or request ran on: absent means Codex.
export function jobRuntime(record: { runtime?: unknown } | null | undefined): CompanionRuntime {
  return record?.runtime === 'claude' ? 'claude' : 'codex';
}

export function runtimeLabel(runtime: CompanionRuntime | null | undefined): string {
  return runtime === 'claude' ? 'Claude' : 'Codex';
}
