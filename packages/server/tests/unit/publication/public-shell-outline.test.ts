import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  flattenPublicCollectionMarkdown,
  injectPublicCollectionShell,
  outlinePublicCollection,
  PUBLIC_SHELL_JSON_LD_ITEM_CAP,
  renderPublicCollectionOutlineHtml,
  type PublicShellMarkdownNode,
} from '../../../src/infrastructure/http/index.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const nodes: readonly PublicShellMarkdownNode[] = [
  { id: 'root', parentId: null, kind: 'root', title: 'root', position: null },
  { id: 'f1', parentId: 'root', kind: 'folder', title: 'Foundations', position: 'a' },
  { id: 'b1', parentId: 'f1', kind: 'bookmark', title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', position: 'a' },
  { id: 'f2', parentId: 'f1', kind: 'folder', title: 'Alignment <b>"quoted"</b>', position: 'b' },
  { id: 'b2', parentId: 'f2', kind: 'bookmark', title: '"><script>alert(1)</script>', url: 'https://example.com/a?b=1&c=2', position: 'a' },
  { id: 'b3', parentId: 'root', kind: 'bookmark', title: 'javascript scheme dropped', url: 'javascript:alert(1)', position: 'b' },
  { id: 'b4', parentId: 'root', kind: 'bookmark', title: 'userinfo dropped', url: 'https://user:pw@example.com/x', position: 'c' },
  { id: 'b5', parentId: 'root', kind: 'bookmark', title: 'Top-level link', url: 'https://example.org/top', position: 'd' },
  { id: 'cycle', parentId: 'cycle', kind: 'folder', title: 'self parent', position: 'z' },
];

const input = {
  surface: 'c' as const,
  slug: 'llm-path',
  collectionId: 'collection-1',
  title: 'LLM path',
  summary: 'From intuition to alignment.',
  curator: 'Ada Curator',
  curatorHandle: 'ada_curator',
  itemCount: 12,
  updatedAt: '2026-08-29T04:19:21.427Z',
  visibility: 'public' as const,
  language: 'zh-cn',
  nodes,
};

test('the shared outline drives byte-identical markdown and an HTML list with the same acceptance rules', () => {
  const { entries, included } = outlinePublicCollection(nodes);
  assert.equal(included, nodes.length);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.depth, entry.title]), [
    ['folder', 0, 'Foundations'],
    ['bookmark', 1, 'Attention Is All You Need'],
    ['folder', 1, 'Alignment <b>"quoted"</b>'],
    ['bookmark', 2, '"><script>alert(1)</script>'],
    ['bookmark', 0, 'Top-level link'],
  ]);
  const { lines } = flattenPublicCollectionMarkdown(nodes);
  assert.deepEqual(lines, [
    '## Foundations',
    '- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)',
    '### Alignment &lt;b&gt;"quoted"&lt;/b&gt;',
    '- ["&gt;&lt;script&gt;alert\\(1\\)&lt;/script&gt;](https://example.com/a?b=1&c=2)',
    '- [Top-level link](https://example.org/top)',
  ]);
  const html = renderPublicCollectionOutlineHtml(entries);
  assert.equal(html, [
    '<h2>Foundations</h2>',
    '<ul>',
    '  <li><a href="https://arxiv.org/abs/1706.03762" rel="nofollow ugc noopener">Attention Is All You Need</a></li>',
    '</ul>',
    '<h3>Alignment &lt;b&gt;"quoted"&lt;/b&gt;</h3>',
    '<ul>',
    '  <li><a href="https://example.com/a?b=1&amp;c=2" rel="nofollow ugc noopener">"&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a></li>',
    '  <li><a href="https://example.org/top" rel="nofollow ugc noopener">Top-level link</a></li>',
    '</ul>',
    '',
  ].join('\n'));
  assert.doesNotMatch(html, /javascript:|user:pw@|<script>/u);
});

test('collection HTML carries the outline, a curator link, remaining count, and enriched JSON-LD', () => {
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, input);
  assert.match(html, /<p>Curated by <a href="\/u\/ada_curator">Ada Curator<\/a> · 12 items · updated 2026-08-29<\/p>/u);
  assert.match(html, /<h2>Foundations<\/h2>/u);
  assert.match(html, /<a href="https:\/\/arxiv\.org\/abs\/1706\.03762" rel="nofollow ugc noopener">Attention Is All You Need<\/a>/u);
  assert.match(html, /<p>and 3 more<\/p>/u);
  assert.match(html, /<a href="\/colp\/v0\.1\/collections\/collection-1\/snapshot">COLP snapshot<\/a>/u);
  assert.doesNotMatch(html, /<script>alert/u);

  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? '';
  const parsed = JSON.parse(jsonLd) as {
    inLanguage: string;
    dateModified: string;
    creator: { '@type': string; name: string; url: string };
    mainEntity: { numberOfItems: number; itemListElement: Array<{ '@type': string; position: number; name: string; url: string }> };
  };
  assert.equal(parsed.inLanguage, 'zh-CN');
  assert.equal(parsed.dateModified, '2026-08-29T04:19:21.427Z');
  assert.deepEqual(parsed.creator, { '@type': 'Person', name: 'Ada Curator', url: 'https://know-n.com/u/ada_curator' });
  assert.equal(parsed.mainEntity.numberOfItems, 12);
  assert.deepEqual(parsed.mainEntity.itemListElement.map((item) => [item.position, item.name, item.url]), [
    [1, 'Attention Is All You Need', 'https://arxiv.org/abs/1706.03762'],
    [2, '"><script>alert(1)</script>', 'https://example.com/a?b=1&c=2'],
    [3, 'Top-level link', 'https://example.org/top'],
  ]);
  assert.doesNotMatch(jsonLd, /<\/script>/u);
});

test('header-only injection is unchanged when nodes are absent and the curator has no public handle', () => {
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, {
    ...input, nodes: undefined, curatorHandle: null, language: null,
  });
  assert.match(html, /<p>Curated by Ada Curator · 12 items · updated 2026-08-29<\/p>/u);
  assert.doesNotMatch(html, /<ul>|and \d+ more|href="\/u\//u);
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? '';
  const parsed = JSON.parse(jsonLd) as Record<string, unknown> & { creator: { url?: string }; mainEntity: Record<string, unknown> };
  assert.equal('inLanguage' in parsed, false);
  assert.equal(parsed.creator.url, undefined);
  assert.equal('itemListElement' in parsed.mainEntity, false);

  const anonymous = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...input, curator: '', curatorHandle: '"><x' });
  assert.match(anonymous, /Curated by Know-N/u);
  assert.doesNotMatch(anonymous, /"creator"|href="\/u\//u);
});

test('JSON-LD item list is capped while the HTML outline keeps every accepted bookmark', () => {
  const many: PublicShellMarkdownNode[] = [
    { id: 'root', parentId: null, kind: 'root', title: 'root', position: null },
    ...Array.from({ length: PUBLIC_SHELL_JSON_LD_ITEM_CAP + 20 }, (_, index) => ({
      id: `b${index}`,
      parentId: 'root',
      kind: 'bookmark' as const,
      title: `Link ${index}`,
      url: `https://example.com/${index}`,
      position: String(index).padStart(4, '0'),
    })),
  ];
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...input, nodes: many, itemCount: many.length });
  assert.equal((html.match(/rel="nofollow ugc noopener"/gu) ?? []).length, PUBLIC_SHELL_JSON_LD_ITEM_CAP + 20);
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? '';
  const parsed = JSON.parse(jsonLd) as { mainEntity: { itemListElement: unknown[] } };
  assert.equal(parsed.mainEntity.itemListElement.length, PUBLIC_SHELL_JSON_LD_ITEM_CAP);
  assert.doesNotMatch(html, /and \d+ more/u);
});
