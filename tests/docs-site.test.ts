import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

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

test('marketing site has no external subresources', () => {
  const html = read('docs/index.html');

  assert.doesNotMatch(html, /<link\b(?=[^>]*\brel=["'][^"']*\bstylesheet\b)[^>]*>/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<img\b[^>]*\bsrc=["']https?:/i);
  assert.doesNotMatch(html, /@import\s+(?:url\()?\s*["']?https?:/i);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i);
});
