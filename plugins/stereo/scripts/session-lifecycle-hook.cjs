#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { checkNodeVersion } = require('./node-version-guard.cjs');

const nodeStatus = checkNodeVersion();
if (!nodeStatus.supported) {
  if (process.argv[2] === 'SessionStart') {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: nodeStatus.message,
        },
      })}\n`,
    );
  }
  process.exit(0);
}

const entry = pathToFileURL(path.join(__dirname, 'session-lifecycle-hook.ts')).href;
import(entry)
  .then((module) => module.main())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
