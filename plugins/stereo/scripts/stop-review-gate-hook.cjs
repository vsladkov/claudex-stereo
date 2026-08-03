#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { checkNodeVersion } = require('./node-version-guard.cjs');

const nodeStatus = checkNodeVersion();
if (!nodeStatus.supported) {
  process.stderr.write(`${nodeStatus.message}\n`);
  process.exit(0);
}

const entry = pathToFileURL(path.join(__dirname, 'stop-review-gate-hook.ts')).href;
import(entry)
  .then((module) => module.main())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
