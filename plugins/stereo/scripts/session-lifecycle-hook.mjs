#!/usr/bin/env node

import process from "node:process";

import { runSessionLifecycleHook } from "../src/hooks/session-lifecycle.ts";

runSessionLifecycleHook().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
