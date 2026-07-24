import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored on this file's on-disk location (src/shared/): sources run with no
// emit, so import.meta.url always points into the real plugin tree.
export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const SCHEMAS_DIR = path.join(PLUGIN_ROOT, 'schemas');

// loadPromptTemplate joins "prompts" itself, so the prompts root is the plugin root.
export const PROMPTS_ROOT = PLUGIN_ROOT;

export const COMPANION_ENTRY = path.join(PLUGIN_ROOT, 'scripts', 'codex-companion.ts');

export const BROKER_ENTRY = path.join(PLUGIN_ROOT, 'scripts', 'app-server-broker.ts');
