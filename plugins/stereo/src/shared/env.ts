// A positive-integer setting read from the environment: unset, blank, or
// unparsable falls back; zero or a negative value reads as 0, which a caller
// with a disabled state treats as disabled (one without reads its setting
// through positiveIntEnvOr).
export function parsePositiveIntEnv(raw: string | null | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed > 0 ? parsed : 0;
}

// A setting that must be a positive integer: anything else (unset, blank,
// unparsable, zero, or negative) is the fallback.
export function positiveIntEnvOr(raw: string | null | undefined, fallback: number): number {
  const parsed = parsePositiveIntEnv(raw, fallback);
  return parsed > 0 ? parsed : fallback;
}
