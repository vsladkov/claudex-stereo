import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, splitRawArgumentString } from '../plugins/stereo/src/shared/args.ts';

test('parseArgs separates value options, boolean options, and positionals', () => {
  const { options, positionals } = parseArgs(
    ['--model', 'sol', '--json', 'describe', 'the', 'task'],
    { valueOptions: ['model'], booleanOptions: ['json'] },
  );
  assert.deepEqual(options, { model: 'sol', json: true });
  assert.deepEqual(positionals, ['describe', 'the', 'task']);
});

test('parseArgs resolves aliases for long and short flags', () => {
  const { options } = parseArgs(['-m', 'mini', '--bg'], {
    valueOptions: ['model'],
    booleanOptions: ['background'],
    aliasMap: { m: 'model', bg: 'background' },
  });
  assert.deepEqual(options, { model: 'mini', background: true });
});

test('parseArgs supports inline values and boolean =false', () => {
  const { options } = parseArgs(['--model=gpt-5.4', '--json=false', '--wait=true'], {
    valueOptions: ['model'],
    booleanOptions: ['json', 'wait'],
  });
  assert.deepEqual(options, { model: 'gpt-5.4', json: false, wait: true });
});

test('parseArgs accumulates repeatable array options without changing scalar options', () => {
  const values = [
    `question with "quotes" and 'apostrophes'`,
    'question with\nan embedded newline',
    '-leading-dash',
    '$(touch nope); `still literal` & more',
  ] as const;
  const { options } = parseArgs(
    [
      '--open-question',
      values[0],
      '--open-question',
      values[1],
      '--residual-risk',
      values[2],
      '--residual-risk',
      values[3],
      '--model',
      'sol',
    ],
    {
      valueOptions: ['model'],
      arrayOptions: ['open-question', 'residual-risk'],
    },
  );

  assert.deepEqual(options, {
    'open-question': [...values.slice(0, 2)],
    'residual-risk': [...values.slice(2)],
    model: 'sol',
  });
});

test('parseArgs supports inline and aliased array option values', () => {
  const { options } = parseArgs(['--risk=first', '-r', 'second'], {
    arrayOptions: ['residual-risk'],
    aliasMap: { risk: 'residual-risk', r: 'residual-risk' },
  });

  assert.deepEqual(options, { 'residual-risk': ['first', 'second'] });
});

test('parseArgs throws on missing values for both flag forms', () => {
  assert.throws(
    () => parseArgs(['--model'], { valueOptions: ['model'] }),
    /Missing value for --model/,
  );
  assert.throws(
    () => parseArgs(['-m'], { valueOptions: ['model'], aliasMap: { m: 'model' } }),
    /Missing value for -m/,
  );
  assert.throws(
    () => parseArgs(['--open-question'], { arrayOptions: ['open-question'] }),
    /Missing value for --open-question/,
  );
});

test('parseArgs treats unknown flags, lone dash, and post -- tokens as positionals', () => {
  const { options, positionals } = parseArgs(['--unknown', '-', '--', '--model', 'raw'], {
    valueOptions: ['model'],
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ['--unknown', '-', '--model', 'raw']);
});

test('splitRawArgumentString honors quotes, escapes, and whitespace runs', () => {
  assert.deepEqual(splitRawArgumentString('--model sol run the   task'), [
    '--model',
    'sol',
    'run',
    'the',
    'task',
  ]);
  assert.deepEqual(splitRawArgumentString('fix \'the broken thing\' "in one" pass'), [
    'fix',
    'the broken thing',
    'in one',
    'pass',
  ]);
  assert.deepEqual(splitRawArgumentString('escaped\\ space and\\"quote'), [
    'escaped space',
    'and"quote',
  ]);
  assert.deepEqual(splitRawArgumentString('trailing\\'), ['trailing\\']);
  assert.deepEqual(splitRawArgumentString('   '), []);
});
