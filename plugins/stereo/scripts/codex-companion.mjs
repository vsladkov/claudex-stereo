#!/usr/bin/env node

import { runCli } from "../src/cli/main.ts";

await runCli(process.argv.slice(2));
