import fs from 'node:fs';

import { PLUGIN_MANIFEST_FILE } from './paths.ts';

// Strict counterpart to the transport's soft readPluginVersion: the `version`
// subcommand must fail loudly (and through the --json error contract) rather
// than report a placeholder version.
export function readPluginManifestVersion(manifestFile: string = PLUGIN_MANIFEST_FILE): string {
  let contents: string;
  try {
    contents = fs.readFileSync(manifestFile, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the plugin manifest ${manifestFile}: ${(error as NodeJS.ErrnoException | null)?.message ?? error}`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new Error(`Could not parse the plugin manifest ${manifestFile} as JSON.`);
  }

  const version = (manifest as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`The plugin manifest ${manifestFile} has no string "version" field.`);
  }
  return version.trim();
}
