import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ROLE_DEFINITIONS } from '../plugins/stereo/src/models/role-defaults.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function githubSlug(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('marketing-site README fragments resolve to headings', () => {
  const html = read('docs/index.html');
  const readme = read('README.md');
  const headings = new Set(
    [...readme.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((match) => githubSlug(match[1] ?? '')),
  );
  const links = [
    ...html.matchAll(
      /href="https:\/\/github\.com\/vsladkov\/claudex-stereo(?:\/blob\/main\/README\.md)?#([^"]+)"/g,
    ),
  ];

  assert.ok(links.length > 0, 'the site should link to README sections');
  for (const match of links) {
    const fragment = match[1] ?? '';
    assert.ok(headings.has(decodeURIComponent(fragment)), `README heading #${fragment} is missing`);
  }
});

test('README-internal fragment links resolve to README headings', () => {
  const readme = read('README.md');
  const headings = new Set(
    [...readme.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((match) => githubSlug(match[1] ?? '')),
  );
  const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)];

  assert.ok(links.length > 0, 'the README should cross-link its own sections');
  for (const match of links) {
    const fragment = match[1] ?? '';
    assert.ok(headings.has(decodeURIComponent(fragment)), `README heading #${fragment} is missing`);
  }
});

test('marketing-site install commands match plugin manifests', () => {
  const html = read('docs/index.html');
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string };
  const plugin = JSON.parse(read('plugins/stereo/.claude-plugin/plugin.json')) as { name: string };
  const packageJson = JSON.parse(read('package.json')) as { repository: { url: string } };
  const repositoryPath = new URL(packageJson.repository.url.replace(/^git\+/, '')).pathname
    .replace(/^\//, '')
    .replace(/\.git$/, '');
  const repositoryOwner = repositoryPath.split('/')[0] ?? '';

  assert.match(
    html,
    new RegExp(
      `/plugin marketplace add ${escapeRegex(repositoryOwner)}/${escapeRegex(marketplace.name)}`,
    ),
    'the marketplace-add command must use the repository manifest name',
  );
  assert.match(
    html,
    new RegExp(`/plugin install ${escapeRegex(plugin.name)}@${escapeRegex(marketplace.name)}`),
    'the install command must use the plugin and marketplace manifest names',
  );
});

test('plugin manifests expose the display name without changing install identities', () => {
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as {
    name: string;
    description?: string;
    plugins: Array<{ name: string; displayName?: string }>;
  };
  const plugin = JSON.parse(read('plugins/stereo/.claude-plugin/plugin.json')) as {
    name: string;
    displayName?: string;
  };

  assert.equal(plugin.name, 'stereo');
  assert.equal(plugin.displayName, 'Claudex Stereo');
  assert.equal(marketplace.name, 'claudex-stereo');
  assert.equal(marketplace.plugins[0]?.name, 'stereo');
  assert.equal(marketplace.plugins[0]?.displayName, 'Claudex Stereo');
  assert.equal(typeof marketplace.description, 'string');
});

test('marketing site has no external subresources beyond the analytics loader', () => {
  for (const page of ['docs/index.html', 'docs/404.html']) {
    const html = read(page);

    assert.doesNotMatch(html, /<link\b(?=[^>]*\brel=["'][^"']*\bstylesheet\b)[^>]*>/i, page);
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      assert.ok(
        (match[1] ?? '').startsWith('https://www.googletagmanager.com/gtag/js'),
        `${page}: unexpected external script ${match[1]}`,
      );
    }
    assert.doesNotMatch(html, /<img\b[^>]*\bsrc=["']https?:/i, page);
    assert.doesNotMatch(html, /@import\s+(?:url\()?\s*["']?https?:/i, page);
    assert.doesNotMatch(html, /url\(\s*["']?https?:/i, page);
  }
});

test('the model chooser starts on the built-in role defaults its script compares against', () => {
  const html = read('docs/index.html');
  const block = html.match(/const defaults = \{([^}]*)\};/)?.[1];
  assert.ok(block, 'docs/index.html declares the defaults object');
  const siteDefaults = new Map<string, string>();
  for (const match of block.matchAll(/'?([a-z-]+)'?:\s*'([^']+)'/g)) {
    siteDefaults.set(match[1] ?? '', match[2] ?? '');
  }
  assert.deepEqual(
    siteDefaults,
    new Map(ROLE_DEFINITIONS.map((role) => [role.flag, role.builtInSelection])),
    'the defaults object mirrors the built-in role selections',
  );
  const checked = new Map<string, string>();
  for (const fieldset of html.matchAll(/<fieldset>([\s\S]*?)<\/fieldset>/g)) {
    const radios = [...(fieldset[1] ?? '').matchAll(/<input\b[^>]*\btype="radio"[^>]*>/g)].map(
      (match) => match[0],
    );
    if (radios.length === 0) {
      continue;
    }
    const name = radios[0]?.match(/\bname="([^"]+)"/)?.[1] ?? '';
    const selected = radios.filter((radio) => /\bchecked\b/.test(radio));
    assert.equal(selected.length, 1, `fieldset ${name} has exactly one checked radio`);
    checked.set(name, selected[0]?.match(/\bvalue="([^"]+)"/)?.[1] ?? '');
  }
  assert.deepEqual(checked, siteDefaults, 'each fieldset starts checked on its default');
});

test('every STEREO_ environment variable the README names exists in the plugin source', () => {
  const readme = read('README.md');
  const named = new Set(readme.match(/\bSTEREO_[A-Z0-9_]+\b/g) ?? []);
  assert.ok(named.size > 0, 'the README documents at least one STEREO_ variable');
  const sourceRoot = path.join(ROOT, 'plugins', 'stereo', 'src');
  const sources = (fs.readdirSync(sourceRoot, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => fs.readFileSync(path.join(sourceRoot, file), 'utf8'))
    .join('\n');
  for (const name of named) {
    assert.ok(sources.includes(`'${name}'`), `${name} is not read anywhere in plugins/stereo/src`);
  }
});
