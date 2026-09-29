import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeModelId, describeClaudeModels } from '../plugins/stereo/src/models/claude-models.ts';
import {
  compareModelVersions,
  findModelVersion,
  latestModelVersion,
  MODEL_VERSIONS,
  modelVersionRows,
} from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';
import { defaultModelEffort, describeModels } from '../plugins/stereo/src/models/registry.ts';
import { accountCatalogModels, catalogEntry, catalogFixture } from './helpers.ts';

const claudeRows = MODEL_VERSIONS.filter((row) => row.runtime === 'claude');
const claudeFamilies = [...new Set(claudeRows.map((row) => row.family))];

test('versions compare numerically per segment', () => {
  assert.ok(
    compareModelVersions('5.10', '5.9') > 0,
    '5.10 outranks 5.9 numerically, not lexically',
  );
  assert.ok(compareModelVersions('6', '5.6') > 0);
  assert.ok(compareModelVersions('5.6.1', '5.6') > 0);
  assert.equal(compareModelVersions('5.5.0', '5.5'), 0);
  assert.ok(compareModelVersions('4.8', '5.5') < 0);
});

test('family rows come back newest-first, per runtime, and an exact version finds its row', () => {
  for (const family of claudeFamilies) {
    const rows = modelVersionRows('claude', family);
    const versions = rows.map((row) => row.version);
    assert.deepEqual(
      versions,
      [...versions].sort((left, right) => compareModelVersions(right, left)),
      family,
    );
    assert.equal(latestModelVersion('claude', family), rows[0], family);
    for (const row of rows) {
      assert.equal(findModelVersion('claude', family, row.version), row);
      assert.equal(findModelVersion('claude', family, `${row.version}.0`), row, 'x.0 is x');
    }
  }
  // The family lookup is trimmed and case-insensitive; rows are per runtime.
  const [first] = claudeFamilies as [string];
  assert.equal(modelVersionRows('claude', ` ${first.toUpperCase()} `).length > 0, true);
  assert.deepEqual(modelVersionRows('codex', first), []);
  assert.deepEqual(modelVersionRows('claude', 'nova'), []);
  assert.equal(latestModelVersion('claude', 'nova'), null);
  assert.equal(findModelVersion('claude', first, '999'), null);
  assert.ok(
    MODEL_VERSIONS.every((row) => row.runtime === 'claude'),
    'no Codex rows ship: the catalog decides Codex versions',
  );
});

test('describeClaudeModels lists every family newest-first with the id and effort per version', () => {
  const described = describeClaudeModels();
  assert.deepEqual(Object.keys(described), claudeFamilies);
  for (const family of claudeFamilies) {
    const rows = modelVersionRows('claude', family);
    assert.deepEqual(described[family], {
      latest: rows[0]?.version,
      versions: Object.fromEntries(
        rows.map((row) => [
          row.version,
          { id: claudeModelId(family, row.version), effort: row.effort },
        ]),
      ),
    });
  }
});

test('describeModels maps every catalog family to its versions with the default effort', () => {
  // `latest` is the version key the alias resolves to, as in the Claude map;
  // that entry's id is the slug a launch passes.
  const described = describeModels(catalogFixture(accountCatalogModels()));
  assert.deepEqual(described.claude, describeClaudeModels());
  assert.deepEqual(described.codex, {
    astra: { latest: '6', versions: { '6': { id: 'gpt-6-astra', effort: 'xhigh' } } },
    luna: {
      latest: '6',
      versions: {
        '6': { id: 'gpt-6-luna', effort: 'xhigh' },
        '5.6': { id: 'gpt-5.6-luna', effort: 'xhigh' },
      },
    },
    sol: {
      latest: '6',
      versions: {
        '6': { id: 'gpt-6-sol', effort: 'xhigh' },
        '5.6': { id: 'gpt-5.6-sol', effort: 'xhigh' },
      },
    },
    terra: {
      latest: '5.6',
      versions: { '5.6': { id: 'gpt-5.6-terra', effort: 'xhigh' } },
    },
  });
  // A version that lists no xhigh steps down; family-less ids are absent.
  const stepped = describeModels(
    catalogFixture([
      catalogEntry('gpt-6-sol'),
      catalogEntry('gpt-5-sol', { efforts: ['low', 'medium', 'high'] }),
      catalogEntry('gpt-5.5'),
    ]),
  );
  assert.deepEqual(stepped.codex, {
    sol: {
      latest: '6',
      versions: {
        '6': { id: 'gpt-6-sol', effort: 'xhigh' },
        '5': { id: 'gpt-5-sol', effort: 'high' },
      },
    },
  });
  assert.deepEqual(describeModels(null).codex, {});
});

test('defaultModelEffort takes a Codex version row over the catalog tier', (t) => {
  const catalog = catalogFixture(accountCatalogModels());
  assert.equal(defaultModelEffort('gpt-5.6-sol', { catalog }), 'xhigh');
  // Codex rows are an extension point no shipped row uses: add one for this test.
  const rows = MODEL_VERSIONS as ModelVersionRow[];
  rows.push({ runtime: 'codex', family: 'sol', version: '5.6', effort: 'high' });
  t.after(() => {
    rows.pop();
  });
  assert.equal(defaultModelEffort('gpt-5.6-sol', { catalog }), 'high');
  assert.equal(defaultModelEffort('gpt-5.6-sol', { runtime: 'codex', catalog }), 'high');
  // A provider-qualified slug matches by its bare id.
  assert.equal(defaultModelEffort('gpt-5.6-sol@azure', { catalog }), 'high');
  // No row for the version, or none for the family: the catalog decides.
  assert.equal(defaultModelEffort('gpt-6-sol', { catalog }), 'xhigh');
  assert.equal(defaultModelEffort('gpt-6-astra', { catalog }), 'xhigh');
  // Third-party registry rows take none.
  assert.equal(defaultModelEffort('kimi-k3', { catalog }), null);
});
