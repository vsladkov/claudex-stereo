import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { makeTempDir } from './helpers.ts';
import { parseCommandInput, readUserFile, wasJsonRequested } from '../plugins/stereo/src/cli/io.ts';
import { readStdinSyncBestEffort, resolveStdinTimeoutMs } from '../plugins/stereo/src/shared/fs.ts';
import { PLUGIN_ROOT } from '../plugins/stereo/src/shared/paths.ts';

// wasJsonRequested keeps module-level state: the raw-argv fallback applies
// only until the first parseCommandInput call in this process, so this test
// must run before any test below that parses.
test('wasJsonRequested scans the provided raw argv before any parse completes', () => {
  assert.equal(wasJsonRequested(['definitely-not-a-subcommand', '--json']), true);

  // Slash commands pass all arguments as one raw string; the fallback splits
  // each token before looking for --json.
  assert.equal(wasJsonRequested(['task', 'do the thing --json']), true);

  assert.equal(wasJsonRequested(['task', 'explain the json flag']), false);
});

test('parseCommandInput separates value flags, boolean flags, and positionals', () => {
  const parsed = parseCommandInput(
    ['--model', 'gpt-5.4-mini', '--background', 'fix', 'the', 'bug', '--unknown-flag'],
    { valueOptions: ['model'], booleanOptions: ['background'] },
  );

  assert.equal(parsed.options.model, 'gpt-5.4-mini');
  assert.equal(parsed.options.background, true);
  assert.deepEqual(parsed.positionals, ['fix', 'the', 'bug', '--unknown-flag']);
});

test('parseCommandInput maps the C alias onto cwd', () => {
  const short = parseCommandInput(['-C', '/some/workspace', 'status'], { valueOptions: ['cwd'] });
  assert.equal(short.options.cwd, '/some/workspace');
  assert.equal(short.options.C, undefined);
  assert.deepEqual(short.positionals, ['status']);

  const long = parseCommandInput(['--C', '/alias/workspace'], { valueOptions: ['cwd'] });
  assert.equal(long.options.cwd, '/alias/workspace');

  const inline = parseCommandInput(['--cwd=/other/workspace'], { valueOptions: ['cwd'] });
  assert.equal(inline.options.cwd, '/other/workspace');
});

test('parseCommandInput splits a single raw argument string like a slash command', () => {
  const parsed = parseCommandInput(['--scope working-tree "focus on auth"'], {
    valueOptions: ['scope'],
  });

  assert.equal(parsed.options.scope, 'working-tree');
  assert.deepEqual(parsed.positionals, ['focus on auth']);
});

test('parseCommandInput keeps everything after -- as positionals', () => {
  const parsed = parseCommandInput(['run', '--', '--background'], {
    booleanOptions: ['background'],
  });

  assert.equal(parsed.options.background, undefined);
  assert.deepEqual(parsed.positionals, ['run', '--background']);
});

test('wasJsonRequested is false post-parse when --json only appears inside prompt text', () => {
  // Multiple argv entries keep the prompt one positional token, exactly like
  // Bash invocations with a quoted prompt argument.
  const parsed = parseCommandInput(['--prompt-file', 'notes.md', 'explain the --json flag'], {
    valueOptions: ['prompt-file'],
    booleanOptions: ['json'],
  });
  assert.equal(parsed.options.json, undefined);
  assert.deepEqual(parsed.positionals, ['explain the --json flag']);

  // Once parsing has completed, the raw-argv fallback must not resurrect a
  // --json that the parse classified as prompt text.
  assert.equal(wasJsonRequested(['task', 'explain the --json flag']), false);
});

test('wasJsonRequested is true post-parse only with a real --json option', () => {
  assert.equal(wasJsonRequested(), false);

  const parsed = parseCommandInput(['--json', 'status'], { booleanOptions: ['json'] });
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.positionals, ['status']);
  assert.equal(wasJsonRequested(), true);
});

test('readUserFile returns file contents resolved against cwd', () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, 'prompt.md'), 'prompt body\n', 'utf8');

  assert.equal(readUserFile(cwd, '--prompt-file', 'prompt.md'), 'prompt body\n');
});

test('readUserFile reports the flag name and resolved path when the read fails', () => {
  const cwd = makeTempDir();
  const resolved = path.resolve(cwd, 'does-not-exist.md');

  assert.throws(
    () => readUserFile(cwd, '--prompt-file', 'does-not-exist.md'),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(`Could not read --prompt-file ${resolved}:`),
  );
});

test('readStdinSyncBestEffort retries EAGAIN and returns data through EOF', () => {
  let call = 0;
  const readImpl = ((
    _fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    _length: number,
  ) => {
    call += 1;
    if (call === 1) {
      throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
    }
    if (call === 2) {
      return Buffer.from('hook input').copy(buffer as Buffer, offset);
    }
    throw Object.assign(new Error('end of file'), { code: 'EOF' });
  }) as typeof fs.readSync;

  assert.equal(readStdinSyncBestEffort({ readImpl, nowImpl: () => 0 }), 'hook input');
});

test('readStdinSyncBestEffort bounds persistent EAGAIN and swallows other errors', () => {
  let now = 0;
  const eagain = (() => {
    throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
  }) as typeof fs.readSync;
  assert.equal(
    readStdinSyncBestEffort({
      readImpl: eagain,
      nowImpl: () => {
        now += 125;
        return now;
      },
      budgetMs: 250,
    }),
    '',
  );

  const denied = (() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  }) as typeof fs.readSync;
  assert.equal(readStdinSyncBestEffort({ readImpl: denied }), '');
});

test('resolveStdinTimeoutMs uses the broker-style positive deadline parser', () => {
  assert.equal(resolveStdinTimeoutMs({}), 10_000);
  assert.equal(resolveStdinTimeoutMs({ CODEX_STDIN_TIMEOUT_MS: '500' }), 500);
  assert.equal(resolveStdinTimeoutMs({ CODEX_STDIN_TIMEOUT_MS: '0' }), 0);
  assert.equal(resolveStdinTimeoutMs({ CODEX_STDIN_TIMEOUT_MS: 'invalid' }), 10_000);
});

test('readUserFile allows workspace, temp, and plugin files', () => {
  const workspace = makeTempDir();
  const nested = path.join(workspace, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(workspace, 'workspace.md'), 'workspace\n', 'utf8');
  const tempFile = path.join(makeTempDir(), 'temp.md');
  fs.writeFileSync(tempFile, 'temp\n', 'utf8');

  assert.equal(readUserFile(nested, '--prompt-file', '../workspace.md'), 'workspace\n');
  assert.equal(readUserFile(nested, '--prompt-file', tempFile), 'temp\n');
  assert.match(
    readUserFile(
      nested,
      '--output-schema',
      path.join(PLUGIN_ROOT, 'schemas', 'review-output.schema.json'),
    ),
    /"findings"/,
  );
});

test('readUserFile rejects lexical escapes and symlinks whose targets are outside every root', () => {
  const outside = fs.realpathSync(process.execPath);
  const escaped = path.relative(PLUGIN_ROOT, outside);
  const escapedResolved = path.resolve(PLUGIN_ROOT, escaped);
  assert.throws(
    () => readUserFile(PLUGIN_ROOT, '--prompt-file', escaped),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(`Refusing to read --prompt-file ${escapedResolved}:`),
  );

  const tempDir = makeTempDir();
  const link = path.join(tempDir, 'outside-link');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return;
    }
    throw error;
  }
  assert.throws(
    () => readUserFile(tempDir, '--prompt-file', link),
    (error: unknown) =>
      error instanceof Error && error.message.startsWith(`Refusing to read --prompt-file ${link}:`),
  );
});

test('readUserFile rejects files larger than 16 MiB', () => {
  const cwd = makeTempDir();
  const oversized = path.join(cwd, 'oversized.md');
  fs.writeFileSync(oversized, Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));

  assert.throws(
    () => readUserFile(cwd, '--prompt-file', oversized),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `--prompt-file ${oversized} is larger than 16 MiB.`,
  );
});
