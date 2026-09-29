import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from '../shared/paths.ts';

// The Claude roles the companion can run headlessly. Each maps to the role
// definition of the same name under the plugin's roles/ directory (not
// agents/, so Claude Code never registers them as Agent types), whose body
// becomes the system prompt of a per-run `--agents` definition.
export const CLAUDE_ROLES = [
  'planner',
  'implementer',
  'plan-reviewer',
  'implementation-reviewer',
  'reviewer',
  'adversarial-reviewer',
] as const;
export type ClaudeRole = (typeof CLAUDE_ROLES)[number];
const CLAUDE_ROLE_SET: ReadonlySet<string> = new Set(CLAUDE_ROLES);

export const CLAUDE_ROLE_HINT = `Use one of: ${CLAUDE_ROLES.join(', ')}.`;

export function normalizeClaudeRole(value: unknown): ClaudeRole | null {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!CLAUDE_ROLE_SET.has(normalized)) {
    throw new Error(`Unsupported --role "${value}". ${CLAUDE_ROLE_HINT}`);
  }
  return normalized as ClaudeRole;
}

// Which roles write files; everything else runs read-only.
export function roleWrites(role: ClaudeRole | null): boolean {
  return role === 'implementer';
}

export interface RoleAgentDefinition {
  /** The `--agents` key and `--agent` name; prefixed so it never collides with the installed plugin's agents. */
  name: string;
  description: string;
  tools: string[];
  prompt: string;
}

export interface LoadRoleAgentOptions {
  pluginRoot?: string;
}

function parseFrontmatter(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) {
    return { fields: {}, body: source };
  }
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { fields, body: source.slice(match[0].length) };
}

// Reads roles/<role>.md and turns it into the pieces of an `--agents` JSON
// definition: frontmatter `tools` (comma list) and `description`, and the body
// as the system prompt with `${CLAUDE_PLUGIN_ROOT}` pointing at the real plugin
// root, since the nested session has no plugin environment of its own.
export function loadRoleAgentDefinition(
  role: ClaudeRole,
  options: LoadRoleAgentOptions = {},
): RoleAgentDefinition {
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  const file = path.join(pluginRoot, 'roles', `${role}.md`);
  const { fields, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const tools = (fields.tools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
  return {
    name: `stereo-${role}`,
    description: fields.description ?? `Stereo ${role}`,
    tools,
    prompt: body.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot).trim(),
  };
}

export interface AgentsFilePayloadOptions {
  model: string;
  effort: string | null;
  /** Adds the StructuredOutput tool, which a restricted tools list would otherwise remove. */
  structuredOutput: boolean;
}

export function buildAgentsFilePayload(
  definition: RoleAgentDefinition,
  options: AgentsFilePayloadOptions,
): Record<string, unknown> {
  const tools = [...definition.tools];
  if (options.structuredOutput && !tools.includes('StructuredOutput')) {
    tools.push('StructuredOutput');
  }
  return {
    [definition.name]: {
      description: definition.description,
      prompt: definition.prompt,
      ...(tools.length > 0 ? { tools } : {}),
      model: options.model,
      ...(options.effort ? { effort: options.effort } : {}),
    },
  };
}

// One file per run under a private temp directory; the caller removes the
// directory when the run ends.
export function writeAgentsFile(directory: string, payload: Record<string, unknown>): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'agents.json');
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  return file;
}
