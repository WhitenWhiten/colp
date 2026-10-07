import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildPublicCollectionMarkdown,
  buildPublicCollectionMarkdownNotFound,
  escapePublicShellMarkdown,
  flattenPublicCollectionMarkdown,
  isPublicShellMarkdownUrl,
  PUBLIC_SHELL_MARKDOWN_ITEM_CAP,
  type PublicShellMarkdownNode,
} from '../../../src/infrastructure/http/index.js';

function node(
  id: string,
  kind: PublicShellMarkdownNode['kind'],
  overrides: Partial<PublicShellMarkdownNode> = {},
): PublicShellMarkdownNode {
  return {
    id,
    parentId: kind === 'root' ? null : 'root',
    kind,
    title: id,
    url: kind === 'bookmark' ? `https://example.test/${id}` : null,
    position: kind === 'root' ? null : id,
    ...overrides,
  };
}

const root = node('root', 'root', { title: 'Root' });

test('flattens folders as headings and bookmarks as bullets in sibling order', () => {
  const { lines, included } = flattenPublicCollectionMarkdown([
    root,
    node('folder-b', 'folder', { title: 'Later', position: 'b' }),
    node('bm-root', 'bookmark', { title: 'Root link', position: 'a-mid' }),
    node('folder-a', 'folder', { title: 'First', position: 'a' }),
    node('bm-a', 'bookmark', { parentId: 'folder-a', title: 'Nested', position: 'a' }),
    node('bm-b', 'bookmark', { parentId: 'folder-b', title: 'Other', position: 'a' }),
  ]);
  assert.deepEqual(lines, [
    '## First',
    '- [Nested](https://example.test/bm-a)',
    '- [Root link](https://example.test/bm-root)',
    '## Later',
    '- [Other](https://example.test/bm-b)',
  ]);
  assert.equal(included, 6);
});

test('nested folders use ### at depth 1', () => {
  const { lines } = flattenPublicCollectionMarkdown([
    root,
    node('outer', 'folder', { title: 'Outer', position: 'a' }),
    node('inner', 'folder', { parentId: 'outer', title: 'Inner', position: 'a' }),
    node('deep', 'bookmark', { parentId: 'inner', title: 'Deep', position: 'a' }),
  ]);
  assert.deepEqual(lines, [
    '## Outer',
    '### Inner',
    '- [Deep](https://example.test/deep)',
  ]);
});

test('URL sanitization keeps http(s) and drops javascript / userinfo', () => {
  assert.equal(isPublicShellMarkdownUrl('https://example.test/ok'), true);
  assert.equal(isPublicShellMarkdownUrl('http://example.test/ok'), true);
  assert.equal(isPublicShellMarkdownUrl('javascript:alert(1)'), false);
  assert.equal(isPublicShellMarkdownUrl('https://user:pass@example.test/secret'), false);
  assert.equal(isPublicShellMarkdownUrl('https://user@example.test/secret'), false);
  const { lines } = flattenPublicCollectionMarkdown([
    root,
    node('safe', 'bookmark', { title: 'Safe', url: 'https://example.test/ok', position: 'a' }),
    node('js', 'bookmark', { title: 'Bad', url: 'javascript:alert(1)', position: 'b' }),
    node('userinfo', 'bookmark', {
      title: 'Hidden', url: 'https://user:pass@example.test/x', position: 'c',
    }),
  ]);
  assert.deepEqual(lines, ['- [Safe](https://example.test/ok)']);
  assert.equal(lines.some((line) => line.includes('javascript:')), false);
  assert.equal(lines.some((line) => line.includes('user:pass')), false);
});

test('escapes ] ( ) in titles so they cannot break link syntax', () => {
  assert.equal(escapePublicShellMarkdown('click](https://evil.test)'), 'click\\]\\(https://evil.test\\)');
  const { lines } = flattenPublicCollectionMarkdown([
    root,
    node('inject', 'bookmark', {
      title: '[click](javascript:alert(1))',
      url: 'https://example.test/safe',
      position: 'a',
    }),
  ]);
  assert.equal(lines[0], '- [\\[click\\]\\(javascript:alert\\(1\\)\\)](https://example.test/safe)');
  assert.equal(lines[0]?.includes('[click](javascript:'), false);
});

test('500-item cap plus and N more uses remaining live nodes', () => {
  const bookmarks = Array.from({ length: PUBLIC_SHELL_MARKDOWN_ITEM_CAP + 2 }, (_, index) =>
    node(`bm-${String(index).padStart(3, '0')}`, 'bookmark', {
      title: `Item ${index}`,
      position: String(index).padStart(3, '0'),
    }));
  const { lines, included } = flattenPublicCollectionMarkdown([root, ...bookmarks]);
  assert.equal(included, PUBLIC_SHELL_MARKDOWN_ITEM_CAP);
  assert.equal(lines.length, PUBLIC_SHELL_MARKDOWN_ITEM_CAP - 1);
  const body = buildPublicCollectionMarkdown({
    collectionId: 'collection-1',
    title: 'Big',
    summary: 'Many links.',
    curator: 'Ada',
    updatedAt: '2026-07-23T00:00:00.000Z',
    visibility: 'public',
    nodes: [root, ...bookmarks],
    nodeCount: 600,
  });
  assert.match(body, /^# Big$/mu);
  assert.match(body, /and 100 more/u);
  assert.equal((body.match(/^- \[/gmu) ?? []).length, PUBLIC_SHELL_MARKDOWN_ITEM_CAP - 1);
});

test('unknown-slug 404 markdown points at sitemap.xml and llms.txt', () => {
  const body = buildPublicCollectionMarkdownNotFound();
  assert.match(body, /# Collection not found/u);
  assert.match(body, /\/sitemap\.xml/u);
  assert.match(body, /\/llms\.txt/u);
});

test('XSS and markdown injection do not appear as raw HTML or unsafe links', () => {
  const body = buildPublicCollectionMarkdown({
    collectionId: 'collection-1',
    title: '"><script>alert(1)</script>',
    summary: '"><script>alert(1)</script>',
    curator: 'Ada',
    updatedAt: '2026-07-23T00:00:00.000Z',
    visibility: 'public',
    nodes: [
      root,
      node('xss', 'bookmark', {
        title: '[click](javascript:alert(1))',
        url: 'javascript:alert(1)',
        position: 'a',
      }),
    ],
    nodeCount: 2,
  });
  assert.equal(body.includes('<script>'), false);
  assert.equal(body.includes('"><script>'), false);
  assert.equal(body.includes('[click](javascript:'), false);
  assert.equal(body.includes('javascript:alert'), false);
  assert.match(body, /&lt;script&gt;/u);
  assert.match(body, /\[COLP snapshot\]\(\/colp\/v0\.1\/collections\/collection-1\/snapshot\)/u);
  assert.match(body, /\[llms\.txt\]\(\/llms\.txt\)/u);
});

test('unlisted markdown includes robots: noindex', () => {
  const body = buildPublicCollectionMarkdown({
    collectionId: 'collection-1',
    title: 'Quiet',
    summary: 'Hidden from search.',
    curator: 'Ada',
    updatedAt: '2026-07-23T00:00:00.000Z',
    visibility: 'unlisted',
    nodes: [root],
    nodeCount: 1,
  });
  assert.match(body, /robots: noindex/u);
});
