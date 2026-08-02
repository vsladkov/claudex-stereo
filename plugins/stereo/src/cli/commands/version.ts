import { readPluginManifestVersion } from '../../shared/plugin-manifest.ts';
import { outputCommandResult, parseCommandInput } from '../io.ts';

export function handleVersion(argv: string[]): void {
  // `version` is workspace-independent; --cwd/-C is parsed only so the shared
  // flag stays harmless instead of landing in positionals.
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });

  if (positionals.length > 0) {
    throw new Error('version takes only flags; unexpected positional arguments.');
  }

  const version = readPluginManifestVersion();
  outputCommandResult({ version }, `${version}\n`, options.json);
}
