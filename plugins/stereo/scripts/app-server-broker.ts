#!/usr/bin/env node

import process from 'node:process';

import { runBrokerServer } from '../src/broker/server.ts';
import { CodexAppServerClient } from '../src/transport/app-server-client.ts';

runBrokerServer(process.argv.slice(2), {
  connectAppServer: (cwd) => CodexAppServerClient.connect(cwd, { disableBroker: true }),
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
