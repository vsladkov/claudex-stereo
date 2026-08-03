#!/usr/bin/env node

import process from 'node:process';

import { runSessionLifecycleHook } from '../src/hooks/session-lifecycle.ts';
import { isMainModule } from '../src/shared/is-main.ts';

export function main(): void {
  runSessionLifecycleHook().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

if (isMainModule(import.meta.url)) {
  main();
}
