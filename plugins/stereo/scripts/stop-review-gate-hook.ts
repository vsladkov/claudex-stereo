#!/usr/bin/env node

import process from 'node:process';

import { runStopReviewGateHook } from '../src/hooks/stop-review-gate.ts';
import { isMainModule } from '../src/shared/is-main.ts';

export function main(): void {
  try {
    runStopReviewGateHook();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
