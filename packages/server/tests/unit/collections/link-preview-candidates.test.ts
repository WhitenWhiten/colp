import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { extractPreviewCandidates } from '../../../src/infrastructure/collections/index.js';
import {
  LINK_PREVIEW_MAX_CANDIDATES,
  resolvePreviewImageUrl,
  selectPreviewCandidates,
} from '../../../src/modules/collections/index.js';

const PAGE = 'https://news.example.com/2026/09/story';

function page(head: string, body = ''): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe('extractPreviewCandidates', () => {
  test('secure_url outranks og:image, which outranks twitter and image_src', () => {
    const html = page(`
      <link rel="image_src" href="/src.png">
      <meta name="twitter:image" content="https://cdn.example.com/tw.png">
      <meta property="og:image" content="https://cdn.example.com/og.png">
      <meta property="og:image:secure_url" content="https://cdn.example.com/secure.png">
    `);
    assert.deepEqual(extractPreviewCandidates(html, PAGE), [
      { url: 'https://cdn.example.com/secure.png', source: 'og' },
      { url: 'https://cdn.example.com/og.png', source: 'og' },
      { url: 'https://cdn.example.com/tw.png', source: 'twitter' },
    ]);
  });

  test('relative references resolve against the final URL, or <base href> when present', () => {
    assert.deepEqual(
      extractPreviewCandidates(page('<meta property="og:image" content="../img/card.jpg">'), PAGE),
      [{ url: 'https://news.example.com/2026/img/card.jpg', source: 'og' }],
    );
    assert.deepEqual(
      extractPreviewCandidates(page(`
        <base href="https://static.example.net/assets/">
        <meta property="og:image" content="card.jpg">
      `), PAGE),
      [{ url: 'https://static.example.net/assets/card.jpg', source: 'og' }],
    );
  });

  test('duplicate tags collapse, name= works like property=, and keys ignore case', () => {
    const html = page(`
      <meta property="og:image" content="https://cdn.example.com/a.png">
      <meta name="OG:IMAGE" content=" https://cdn.example.com/a.png#fragment ">
      <meta name="twitter:image:src" content="https://cdn.example.com/b.png">
    `);
    assert.deepEqual(extractPreviewCandidates(html, PAGE), [
      { url: 'https://cdn.example.com/a.png', source: 'og' },
      { url: 'https://cdn.example.com/b.png', source: 'twitter' },
    ]);
  });

  test('data:, javascript:, userinfo and empty values never become candidates', () => {
    const html = page(`
      <meta property="og:image" content="data:image/png;base64,AAAA">
      <meta property="og:image" content="javascript:alert(1)">
      <meta property="og:image" content="https://user:pass@cdn.example.com/x.png">
      <meta property="og:image" content="   ">
      <link rel="shortcut image_src" href="//cdn.example.com/fallback.png">
    `);
    assert.deepEqual(extractPreviewCandidates(html, PAGE), [
      { url: 'https://cdn.example.com/fallback.png', source: 'image_src' },
    ]);
  });

  test('pages without a head, or tags after a huge inline script, still parse', () => {
    assert.deepEqual(
      extractPreviewCandidates('<meta property="og:image" content="/bare.png"><p>hi</p>', PAGE),
      [{ url: 'https://news.example.com/bare.png', source: 'og' }],
    );
    const script = `<script>${'var x = "</div>";'.repeat(40_000)}</script>`;
    assert.deepEqual(
      extractPreviewCandidates(page(`${script}<meta property="og:image" content="/late.png">`), PAGE),
      [{ url: 'https://news.example.com/late.png', source: 'og' }],
    );
    assert.deepEqual(extractPreviewCandidates(page('<title>No image</title>'), PAGE), []);
  });

  test('at most three candidates are returned', () => {
    const tags = Array.from({ length: 6 }, (_, i) => `<meta property="og:image" content="/c${i}.png">`).join('');
    assert.equal(extractPreviewCandidates(page(tags), PAGE).length, LINK_PREVIEW_MAX_CANDIDATES);
  });
});

describe('selectPreviewCandidates and resolvePreviewImageUrl', () => {
  test('image_src matches as one token of rel', () => {
    assert.deepEqual(
      selectPreviewCandidates([{ kind: 'link', rel: 'icon', href: '/favicon.png' }], PAGE),
      [],
    );
  });

  test('over-long URLs are refused', () => {
    assert.equal(resolvePreviewImageUrl(`https://cdn.example.com/${'a'.repeat(2100)}`, PAGE), null);
    assert.equal(resolvePreviewImageUrl('http://cdn.example.com/ok.png', PAGE), 'http://cdn.example.com/ok.png');
  });
});
