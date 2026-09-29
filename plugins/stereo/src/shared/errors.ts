export class WriteEscalationRetryError extends Error {
  constructor() {
    super('Retry the write-capable resume on a private runtime.');
    this.name = 'WriteEscalationRetryError';
  }
}

// The text of a thrown value: an Error's message, anything else as a string.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The code of a thrown value (an errno name such as ENOENT), or undefined.
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
