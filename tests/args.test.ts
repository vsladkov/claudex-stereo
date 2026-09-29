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

test('splitRawArgumentString groups quoted words and splits on whitespace runs', () => {
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
  assert.deepEqual(splitRawArgumentString('--focus="two words" --json'), [
    '--focus=two words',
    '--json',
  ]);
  assert.deepEqual(splitRawArgumentString('   '), []);
});

test('splitRawArgumentString keeps a quote inside a word literal', () => {
  // An apostrophe in a path or in prose opens nothing and swallows nothing.
  assert.deepEqual(splitRawArgumentString("job-1 --workspace /home/o'brien/repo --json"), [
    'job-1',
    '--workspace',
    "/home/o'brien/repo",
    '--json',
  ]);
  assert.deepEqual(splitRawArgumentString("don't stop"), ["don't", 'stop']);
  assert.deepEqual(splitRawArgumentString('"it\'s fine" 5"'), ["it's fine", '5"']);
});

test('splitRawArgumentString keeps every backslash except the one before a quote', () => {
  assert.deepEqual(
    splitRawArgumentString('--workspace C:\\dev\\repo --plan-file C:\\tmp\\plan.md'),
    ['--workspace', 'C:\\dev\\repo', '--plan-file', 'C:\\tmp\\plan.md'],
  );
  assert.deepEqual(splitRawArgumentString('"C:\\Program Files\\repo" \'C:\\tmp\\plan.md\''), [
    'C:\\Program Files\\repo',
    'C:\\tmp\\plan.md',
  ]);
  // A UNC prefix keeps both backslashes, and a trailing backslash glues nothing on.
  assert.deepEqual(splitRawArgumentString('--workspace \\\\wsl$\\Ubuntu\\home --json'), [
    '--workspace',
    '\\\\wsl$\\Ubuntu\\home',
    '--json',
  ]);
  assert.deepEqual(splitRawArgumentString('--workspace C:\\repo\\ --json'), [
    '--workspace',
    'C:\\repo\\',
    '--json',
  ]);
  assert.deepEqual(splitRawArgumentString('\\'), ['\\']);
  // The one escape: a backslash makes the quote after it literal.
  assert.deepEqual(splitRawArgumentString('"say \\"hi\\"" \\\'quoted'), ['say "hi"', "'quoted"]);
});

test('an inline --key=value splits on the first = only', () => {
  const parsed = parseArgs(['--allow=Bash(FOO=1 make:*)', '--model=a=b', '--json=false'], {
    valueOptions: ['model'],
    arrayOptions: ['allow'],
    booleanOptions: ['json'],
  });
  assert.deepEqual(parsed.options, {
    allow: ['Bash(FOO=1 make:*)'],
    model: 'a=b',
    json: false,
  });
});
