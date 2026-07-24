export class WriteEscalationRetryError extends Error {
  constructor() {
    super("Retry the write-capable resume on a private runtime.");
    this.name = "WriteEscalationRetryError";
  }
}
