import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPromptTemplate, interpolateTemplate } from '../plugins/stereo/src/shared/prompts.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'stereo');

test('interpolateTemplate substitutes known placeholders', () => {
  assert.equal(
    interpolateTemplate('a {{FIRST}} b {{SECOND}}', { FIRST: '1', SECOND: '' }),
    'a 1 b ',
  );
});

test('interpolateTemplate throws on unknown placeholders instead of blanking them', () => {
  assert.throws(
    () => interpolateTemplate('a {{MISSPELLED_KEY}} b', {}),
    /Unknown template placeholder \{\{MISSPELLED_KEY\}\}/,
  );
});

test('interpolateTemplate never re-scans substituted values', () => {
  // A value containing placeholder syntax must pass through untouched.
  assert.equal(
    interpolateTemplate('{{BODY}}', { BODY: 'keep {{THIS}} literal' }),
    'keep {{THIS}} literal',
  );
});

// Each shipped template interpolated with its production variable set: a
// placeholder added to a template without updating its call site (or vice
// versa) fails here instead of silently degrading a live prompt.
const PRODUCTION_VARIABLES = {
  'adversarial-review': {
    TARGET_LABEL: 'working tree diff',
    USER_FOCUS: 'No extra focus provided.',
    REVIEW_COLLECTION_GUIDANCE: '',
    REVIEW_INPUT: 'diff content',
  },
  'implementation-review': {
    PLAN_INPUT: 'plan text',
    BASELINE_CONTEXT: 'baseline context',
    REVIEW_CONTEXT: 'review context',
    HOST_RESULTS: 'host results',
  },
  'plan-draft': {
    TASK_TEXT: 'task text',
    SIZE_CONTRACT: 'size contract',
  },
  'plan-review': {
    PLAN_INPUT: 'plan text',
    REPO_MAP: '',
    ROUND_NUMBER: '1',
    REVISION_CONTEXT: '',
  },
  review: {
    TARGET_LABEL: 'working tree diff',
    USER_FOCUS: 'No extra focus provided.',
    REVIEW_COLLECTION_GUIDANCE: '',
    REVIEW_INPUT: 'diff content',
  },
  'stop-review-gate': {
    CLAUDE_RESPONSE_BLOCK: '',
  },
};

for (const [name, variables] of Object.entries(PRODUCTION_VARIABLES)) {
  test(`the ${name} template's placeholders exactly match its production variables`, () => {
    const template = loadPromptTemplate(PLUGIN_ROOT, name);
    const placeholders = [
      ...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1])),
    ].sort();
    const productionVariables = Object.keys(variables).sort();
    assert.equal(placeholders.length > 0, true);
    assert.deepEqual(placeholders, productionVariables);
    const rendered = interpolateTemplate(template, variables);
    assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/);
  });
}

test('review prompts fence every untrusted data block from instructions', () => {
  const expectedCounts = {
    'implementation-review': 1,
    'plan-review': 2,
    'adversarial-review': 2,
    review: 2,
  } as const;

  for (const [name, expectedCount] of Object.entries(expectedCounts)) {
    const template = loadPromptTemplate(PLUGIN_ROOT, name);
    assert.equal(
      (template.match(/not instructions/gi) ?? []).length,
      expectedCount,
      `${name} data-boundary count`,
    );
  }

  assert.doesNotMatch(loadPromptTemplate(PLUGIN_ROOT, 'implementation-review'), /schemas\//);
});
