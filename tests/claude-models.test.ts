import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_EFFORT_LADDER,
  CLAUDE_SELECTION_HINT,
  assertClaudeEffortAllowed,
  claudeModelId,
  defaultClaudeEffort,
  detectClaudeFamily,
  normalizeClaudeEffort,
  normalizeServedModelId,
  parseClaudeSelection,
} from '../plugins/stereo/src/models/claude-models.ts';
import {
  defaultModelEffort,
  normalizeReasoningEffort,
  parseModelSelection,
} from '../plugins/stereo/src/models/registry.ts';
import {
  latestModelVersion,
  MODEL_VERSIONS,
  modelVersionRows,
} from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';

const opus = latestModelVersion('claude', 'opus') as ModelVersionRow;
const opusId = claudeModelId('opus', opus.version);
const haiku = latestModelVersion('claude', 'haiku') as ModelVersionRow;
const haikuId = claudeModelId('haiku', haiku.version);
const families = [
  ...new Set(MODEL_VERSIONS.filter((row) => row.runtime === 'claude').map((row) => row.family)),
];

test('claude:<family> is the newest table version and claude:<family>-<version> a row id', () => {
  // The plugin never hands Claude Code a bare alias: the alias names the
  // family's newest row and the launch passes that concrete id.
  assert.deepEqual(parseClaudeSelection('claude:opus'), { modelArg: opusId });
  for (const family of families) {
    const newest = latestModelVersion('claude', family) as ModelVersionRow;
    assert.equal(
      parseClaudeSelection(`claude:${family}`).modelArg,
      claudeModelId(family, newest.version),
    );
    for (const row of modelVersionRows('claude', family)) {
      assert.equal(
        parseClaudeSelection(`claude:${family}-${row.version}`).modelArg,
        claudeModelId(family, row.version),
      );
    }
  }
  // Case and surrounding whitespace are forgiven; a version takes `.` or `-`
  // between its segments, and a matching row spells it.
  const dashed = opus.version.replace(/\./g, '-');
  for (const selection of [
    `CLAUDE:Opus-${opus.version}`,
    `  claude:  opus-${opus.version}  `,
    `claude:opus-${dashed}`,
    `claude:opus-${opus.version}.0`,
  ]) {
    assert.equal(parseClaudeSelection(selection).modelArg, opusId, selection);
  }
  assert.equal(claudeModelId('haiku', '4.5.1'), 'claude-haiku-4-5-1');
});

test('a full claude-<family>-<version> id names its row; a snapshot date or context suffix is refused', () => {
  assert.deepEqual(parseClaudeSelection(`claude:${opusId}`), { modelArg: opusId });
  for (const selection of [`claude:${haikuId}-20251001`, `claude:${opusId}[1m]`]) {
    assert.throws(() => parseClaudeSelection(selection), /^Error: Unsupported model /, selection);
  }
});

test('only the table families and versions parse; everything else is refused before launch', () => {
  const unsupported = (selection: string, where = '') =>
    new Error(`Unsupported model "${selection}"${where}. ${CLAUDE_SELECTION_HINT}`);
  for (const selection of [
    'claude:fabel',
    'claude:sonet-5',
    'claude:opus5.5',
    'claude:opus[1m]',
    'claude:opus@bedrock',
    'claude:opus 5.5',
    'claude:claude-opus',
    'claude:us.anthropic.claude-sonnet-5-v1:0',
    'claude:anthropic/claude-opus-5-5',
    'claude:',
  ]) {
    assert.throws(() => parseClaudeSelection(selection), unsupported(selection), selection);
    // Every path parses the same grammar: --model and a stored role default.
    assert.throws(() => parseModelSelection(selection), unsupported(selection), selection);
  }
  assert.throws(
    () => parseClaudeSelection('claude:fabel', { flag: 'planner' }),
    unsupported('claude:fabel', ' for --planner'),
  );
  // A version the table lacks is refused naming the versions it has, dated
  // family pins included.
  const known = modelVersionRows('claude', 'opus')
    .map((row) => row.version)
    .join(', ');
  for (const selection of ['claude:opus-9', 'claude:opus-20260301', 'claude:claude-opus-9-1']) {
    assert.throws(
      () => parseClaudeSelection(selection),
      new Error(
        `Unsupported model "${selection}": the plugin knows opus versions ${known}; use claude:opus for the newest.`,
      ),
    );
  }
  assert.match(CLAUDE_SELECTION_HINT, new RegExp(`families: ${families.join(', ')};`));
});

test('claude:session and the removed claude:inherit are rejected with pointers', () => {
  assert.throws(
    () => parseClaudeSelection('claude:session'),
    /claude:session runs inline in the Claude session and never reaches the companion/,
  );
  assert.throws(
    () => parseClaudeSelection('claude:inherit'),
    /claude:inherit was removed: select the Claude family or version explicitly/,
  );
  assert.throws(() => parseClaudeSelection('codex:astra'), /Unsupported model "codex:astra"/);
});

test('the Claude effort default is the version row; an id no row matches has none', () => {
  for (const row of MODEL_VERSIONS.filter((candidate) => candidate.runtime === 'claude')) {
    const id = claudeModelId(row.family, row.version);
    assert.equal(defaultClaudeEffort(id), row.effort, id);
    assert.equal(defaultModelEffort(id, { runtime: 'claude' }), row.effort, id);
  }
  assert.equal(defaultClaudeEffort('claude-opus-99'), null);
  assert.equal(defaultClaudeEffort('my-gateway-model'), null);
});

test('the Claude ladder is low..max; Codex-only tiers are rejected with the right ladder named', () => {
  for (const effort of CLAUDE_EFFORT_LADDER) {
    assert.equal(normalizeClaudeEffort(effort), effort);
  }
  assert.equal(normalizeClaudeEffort(' XHIGH '), 'xhigh');
  assert.equal(normalizeClaudeEffort(null), null);
  assert.equal(normalizeClaudeEffort('  '), null);
  for (const effort of ['ultra', 'none', 'minimal', 'hyper']) {
    assert.throws(
      () => normalizeClaudeEffort(effort),
      new Error(
        `Unsupported reasoning effort "${effort}" for a Claude-routed role (--effort). Use one of: low, medium, high, xhigh, max.`,
      ),
      effort,
    );
  }
  assert.throws(
    () => normalizeClaudeEffort('ultra', '--implementer-effort'),
    /for a Claude-routed role \(--implementer-effort\)/,
  );
  assert.throws(() => normalizeReasoningEffort('ultra', 'claude'), /for a Claude-routed role/);
  assert.equal(normalizeReasoningEffort('ultra', 'codex'), 'ultra');
  assert.equal(normalizeReasoningEffort('ultra', null), 'ultra', 'no route: either ladder');
});

test('parseModelSelection routes by prefix', () => {
  const claude = parseModelSelection(`claude:opus-${opus.version}`);
  assert.equal(claude?.runtime === 'claude' ? claude.claude.modelArg : null, opusId);
  const codex = parseModelSelection('codex:sol');
  assert.equal(codex?.runtime === 'codex' ? codex.codex.key : null, 'sol');
  assert.equal(parseModelSelection('gpt-5.5')?.runtime, 'codex');
  assert.equal(parseModelSelection(null), null);
  assert.equal(parseModelSelection('  '), null);
  assert.throws(() => parseModelSelection('claude:session'), /runs inline/);
});

test('served ids: dated snapshots normalize and every family is detected', () => {
  assert.equal(normalizeServedModelId(`${haikuId}-20251001`), haikuId);
  assert.equal(normalizeServedModelId(` ${opusId} `), opusId);
  // A date-like run of eight digits elsewhere in the id is not a snapshot stamp.
  assert.equal(
    normalizeServedModelId('claude-opus-20250101-preview'),
    'claude-opus-20250101-preview',
  );
  for (const family of families) {
    assert.equal(detectClaudeFamily(`claude-${family}-1-2-20260101`), family);
  }
  assert.equal(detectClaudeFamily('gpt-6-astra'), null);
});

test('a version the table gives no effort refuses one, naming where it came from', () => {
  for (const [source, expected] of [
    [undefined, 'drop --effort high'],
    ['--planner-effort', 'drop --planner-effort high'],
    ['the stored workspace effort', 'drop the stored workspace effort high'],
  ] as const) {
    assert.throws(
      () => assertClaudeEffortAllowed(haikuId, 'high', source),
      new Error(
        `claude:haiku takes no effort (the model rejects the parameter); ${expected} for ${haikuId}.`,
      ),
    );
  }
  assert.doesNotThrow(() => assertClaudeEffortAllowed(haikuId, null));
  assert.doesNotThrow(() => assertClaudeEffortAllowed(opusId, 'low'));
  assert.doesNotThrow(() => assertClaudeEffortAllowed('my-gateway-model', 'low'));
});

test('a version that lacks an effort tier refuses it and defaults to a tier it takes', () => {
  const lacking = MODEL_VERSIONS.filter((row) => row.runtime === 'claude' && row.efforts);
  assert.deepEqual(
    lacking.map((row) => claudeModelId(row.family, row.version)),
    ['claude-opus-4-6', 'claude-sonnet-4-6'],
  );
  for (const row of lacking) {
    const id = claudeModelId(row.family, row.version);
    assert.ok(row.effort && row.efforts?.includes(row.effort), `${id} defaults to its own tier`);
    assert.equal(parseClaudeSelection(`claude:${row.family}-${row.version}`).modelArg, id);
    assert.throws(
      () => assertClaudeEffortAllowed(id, 'xhigh', '--implementer-effort'),
      new Error(`${id} does not take --implementer-effort xhigh; it takes low, medium, high, max.`),
    );
    for (const effort of row.efforts ?? []) {
      assert.doesNotThrow(() => assertClaudeEffortAllowed(id, effort));
    }
  }
});
