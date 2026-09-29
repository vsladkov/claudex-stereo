import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildAgentsFilePayload,
  CLAUDE_ROLES,
  loadRoleAgentDefinition,
  normalizeClaudeRole,
  roleWrites,
  writeAgentsFile,
} from '../plugins/stereo/src/runtime/role-agents.ts';
import { PLUGIN_ROOT } from '../plugins/stereo/src/shared/paths.ts';
import { makeTempDir } from './helpers.ts';

test('roles are the six role definitions; only the implementer writes', () => {
  assert.deepEqual(
    [...CLAUDE_ROLES],
    [
      'planner',
      'implementer',
      'plan-reviewer',
      'implementation-reviewer',
      'reviewer',
      'adversarial-reviewer',
    ],
  );
  for (const role of CLAUDE_ROLES) {
    assert.equal(normalizeClaudeRole(` ${role.toUpperCase()} `), role);
    assert.equal(roleWrites(role), role === 'implementer');
  }
  assert.equal(normalizeClaudeRole(null), null);
  assert.equal(normalizeClaudeRole(''), null);
  assert.throws(
    () => normalizeClaudeRole('architect'),
    /Unsupported --role "architect"\. Use one of: planner, implementer, plan-reviewer, implementation-reviewer, reviewer, adversarial-reviewer\./,
  );
});

test('a role definition is read from the shipped markdown with the plugin root substituted', () => {
  const planner = loadRoleAgentDefinition('planner');
  assert.equal(planner.name, 'stereo-planner');
  assert.ok(planner.description.trim().length > 0, 'the frontmatter description is carried');
  assert.deepEqual(planner.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  // Structure only, never the wording: the body is the prompt, the
  // frontmatter is not.
  assert.ok(planner.prompt.trim().length > 0, 'the markdown body becomes the prompt');
  assert.equal(planner.prompt, planner.prompt.trimStart(), 'the prompt starts at the body');
  assert.doesNotMatch(planner.prompt, /^---/m, 'frontmatter is stripped');
  assert.doesNotMatch(planner.prompt, /^(name|description|tools|model):/m, 'no field leaks');

  const reviewer = loadRoleAgentDefinition('plan-reviewer');
  assert.ok(
    // The role markdown joins with a forward slash; only the root is substituted.
    reviewer.prompt.includes(`${PLUGIN_ROOT}/schemas/plan-review-output.schema.json`),
    'schema paths resolve to the real plugin root',
  );
  assert.doesNotMatch(reviewer.prompt, /\$\{CLAUDE_PLUGIN_ROOT\}/);

  const implementer = loadRoleAgentDefinition('implementer');
  assert.deepEqual(implementer.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);

  const custom = makeTempDir();
  fs.mkdirSync(path.join(custom, 'roles'));
  fs.writeFileSync(
    path.join(custom, 'roles', 'reviewer.md'),
    '---\nname: reviewer\ndescription: custom\ntools: Read\n---\n\nBody with ${CLAUDE_PLUGIN_ROOT}/x.\n',
  );
  const definition = loadRoleAgentDefinition('reviewer', { pluginRoot: custom });
  assert.deepEqual(definition.tools, ['Read']);
  assert.equal(definition.prompt, `Body with ${custom}/x.`);
});

test('the agents file carries model and effort and adds StructuredOutput only when a schema is used', () => {
  const definition = loadRoleAgentDefinition('reviewer');
  const structured = buildAgentsFilePayload(definition, {
    model: 'claude-opus-5-5',
    effort: 'high',
    structuredOutput: true,
  });
  const entry = structured['stereo-reviewer'] as Record<string, unknown>;
  assert.equal(entry.model, 'claude-opus-5-5');
  assert.equal(entry.effort, 'high');
  assert.deepEqual(entry.tools, ['Read', 'Glob', 'Grep', 'Bash', 'StructuredOutput']);
  assert.equal(entry.prompt, definition.prompt);

  const plain = buildAgentsFilePayload(definition, {
    model: 'haiku',
    effort: null,
    structuredOutput: false,
  })['stereo-reviewer'] as Record<string, unknown>;
  assert.equal('effort' in plain, false);
  assert.equal((plain.tools as string[]).includes('StructuredOutput'), false);

  const dir = path.join(makeTempDir(), 'run');
  const file = writeAgentsFile(dir, structured);
  assert.equal(path.basename(file), 'agents.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), structured);
});
