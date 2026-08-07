import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffPlanTexts,
  MAX_COMPARE_PLAN_CHARS,
  MAX_COMPARE_PLAN_LINES,
} from '../plugins/stereo/src/shared/diff.ts';

function planWithLines(count: number, options: { terminated: boolean }): string {
  const body = Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
  return options.terminated ? `${body}\n` : body;
}

test('diffPlanTexts reports identical texts without a diff', () => {
  assert.deepEqual(diffPlanTexts('# Plan\n\nStep one.\n', '# Plan\n\nStep one.\n'), {
    identical: true,
    suppressed: false,
    diff: '',
  });
  assert.deepEqual(diffPlanTexts('', ''), { identical: true, suppressed: false, diff: '' });
});

test('diffPlanTexts treats a trailing-newline-only difference as identical', () => {
  assert.deepEqual(diffPlanTexts('# Plan\n\nStep one.\n', '# Plan\n\nStep one.'), {
    identical: true,
    suppressed: false,
    diff: '',
  });
});

test('diffPlanTexts renders a single unified hunk byte-exactly', () => {
  assert.deepEqual(
    diffPlanTexts('# Plan\n\nStep one.\n', '# Plan\n\nStep one revised.\nStep two.\n'),
    {
      identical: false,
      suppressed: false,
      diff: '@@ -1,3 +1,4 @@\n # Plan\n \n-Step one.\n+Step one revised.\n+Step two.',
    },
  );
});

test('diffPlanTexts splits change runs separated by more than six unchanged lines', () => {
  const unchanged = 'keep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7';
  const result = diffPlanTexts(`one\n${unchanged}\ntwo\n`, `ONE\n${unchanged}\nTWO\n`);

  assert.equal(result.identical, false);
  assert.equal(result.suppressed, false);
  assert.equal(
    result.diff,
    '@@ -1,4 +1,4 @@\n-one\n+ONE\n keep 1\n keep 2\n keep 3\n@@ -6,4 +6,4 @@\n keep 5\n keep 6\n keep 7\n-two\n+TWO',
  );
  assert.equal(result.diff.match(/^@@ /gm)?.length, 2);
});

test('diffPlanTexts keeps a change run whose unchanged gap fits both context windows in one hunk', () => {
  const unchanged = 'keep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6';
  const result = diffPlanTexts(`one\n${unchanged}\ntwo\n`, `ONE\n${unchanged}\nTWO\n`);

  assert.equal(result.suppressed, false);
  assert.equal(result.diff.match(/^@@ /gm)?.length, 1);
  assert.equal(
    result.diff,
    '@@ -1,8 +1,8 @@\n-one\n+ONE\n keep 1\n keep 2\n keep 3\n keep 4\n keep 5\n keep 6\n-two\n+TWO',
  );
});

test('diffPlanTexts represents an empty side as zero lines, not one blank line', () => {
  assert.deepEqual(diffPlanTexts('', 'x\n'), {
    identical: false,
    suppressed: false,
    diff: '@@ -0,0 +1,1 @@\n+x',
  });
  assert.deepEqual(diffPlanTexts('x\n', ''), {
    identical: false,
    suppressed: false,
    diff: '@@ -1,1 +0,0 @@\n-x',
  });
});

test('diffPlanTexts compares sides exactly at the line cap', () => {
  for (const terminated of [true, false]) {
    const atCap = diffPlanTexts(planWithLines(MAX_COMPARE_PLAN_LINES, { terminated }), 'only\n');
    assert.equal(atCap.identical, false, `terminated: ${terminated}`);
    assert.equal(atCap.suppressed, false, `terminated: ${terminated}`);
    assert.match(atCap.diff, /^@@ /);
  }
});

test('diffPlanTexts suppresses a side one line past the cap', () => {
  for (const terminated of [true, false]) {
    assert.deepEqual(
      diffPlanTexts(planWithLines(MAX_COMPARE_PLAN_LINES + 1, { terminated }), 'only\n'),
      { identical: false, suppressed: true, diff: '' },
      `terminated: ${terminated}`,
    );
    assert.deepEqual(
      diffPlanTexts('only\n', planWithLines(MAX_COMPARE_PLAN_LINES + 1, { terminated })),
      { identical: false, suppressed: true, diff: '' },
      `terminated: ${terminated}`,
    );
  }
});

test('diffPlanTexts suppresses a high-newline side before splitting it', () => {
  assert.deepEqual(diffPlanTexts('\n'.repeat(MAX_COMPARE_PLAN_LINES * 50), 'only\n'), {
    identical: false,
    suppressed: true,
    diff: '',
  });
});

test('diffPlanTexts suppresses a byte-oversized single line the line cap cannot see', () => {
  const oversized = 'a'.repeat(MAX_COMPARE_PLAN_CHARS + 1);
  assert.equal(oversized.includes('\n'), false);
  assert.deepEqual(diffPlanTexts(oversized, 'a'), {
    identical: false,
    suppressed: true,
    diff: '',
  });
  assert.deepEqual(diffPlanTexts('a', oversized), {
    identical: false,
    suppressed: true,
    diff: '',
  });
});
