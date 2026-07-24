#!/usr/bin/env node

import process from "node:process";

import { runBrokerServer } from "../src/broker/server.ts";

runBrokerServer(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
