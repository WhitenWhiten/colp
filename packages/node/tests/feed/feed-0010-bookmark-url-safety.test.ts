import { describe, expect, it } from 'vitest';

import {
  assertFeedEventBookmarkUrls,
  projectFeedBookmarkUrl,
  projectFeedNodeBookmark,
} from '../../src/feed/bookmark-url.js';

const evidence = 'feed.bookmark-url-safety';

describe(`FEED-0010 feed bookmark URL safety [evidence:${evidence}]`, () => {
  it.each([
    'https://example.com/article',
    'http://example.com/article',
    'HTTPS://example.com/Case-Sensitive',
    'https://example.com/users/user%40example.com?q=user%3Apassword',
  ])(`[success] keeps safe absolute HTTP(S) URL %s [evidence:${evidence}]`, (url) => {
    expect(projectFeedBookmarkUrl(url)).toEqual({ outcome: 'keep', url });
  });

  it.each([
    'https://user:password@example.com/private',
    'HTTP://user%3Apassword@example.com/private',
    'file:///C:/Docs/private.html',
    'javascript:alert(1)',
    'data:text/html,hi',
    'not-a-url',
    '',
  ])(`[negative] omits unsafe target %s [evidence:${evidence}]`, (url) => {
    expect(projectFeedBookmarkUrl(url)).toEqual({ outcome: 'omit' });
  });

  it(`[success] redact mode returns redacted summary without target URL [evidence:${evidence}]`, () => {
    const result = projectFeedBookmarkUrl('https://user:pass@example.com/x', { mode: 'redact' });
    expect(result).toEqual({ outcome: 'redact', redacted: true });
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it(`[success] projectFeedNodeBookmark keeps safe bookmark URL [evidence:${evidence}]`, () => {
    const node = projectFeedNodeBookmark({
      id: 'node-1',
      kind: 'bookmark',
      title: 'Safe',
      url: 'https://example.com/a',
    });
    expect(node).toMatchObject({
      id: 'node-1',
      kind: 'bookmark',
      url: 'https://example.com/a',
    });
  });

  it(`[negative] projectFeedNodeBookmark omits unsafe URL [evidence:${evidence}]`, () => {
    const node = projectFeedNodeBookmark({
      id: 'node-1',
      kind: 'bookmark',
      url: 'https://user:secret@example.com/a',
    });
    expect(node).toEqual({ id: 'node-1', kind: 'bookmark' });
    expect(node).not.toHaveProperty('url');
  });

  it(`[negative] redact mode sets redacted without embedding target [evidence:${evidence}]`, () => {
    const node = projectFeedNodeBookmark(
      {
        id: 'node-1',
        kind: 'bookmark',
        url: 'file:///etc/passwd',
      },
      { mode: 'redact' },
    );
    expect(node).toEqual({ id: 'node-1', kind: 'bookmark', redacted: true });
    expect(JSON.stringify(node)).not.toContain('passwd');
  });

  it(`[boundary] non-bookmark nodes pass through without url rewriting [evidence:${evidence}]`, () => {
    const node = projectFeedNodeBookmark({ id: 'folder-1', kind: 'folder', title: 'F' });
    expect(node).toMatchObject({ id: 'folder-1', kind: 'folder', title: 'F' });
  });

  it(`[negative] assertFeedEventBookmarkUrls throws on unsafe bookmark [evidence:${evidence}]`, () => {
    expect(() =>
      assertFeedEventBookmarkUrls({
        node: { kind: 'bookmark', url: 'https://user:x@host/y' },
      }),
    ).toThrow(/unsafe/i);
  });

  it(`[success] assertFeedEventBookmarkUrls accepts safe bookmark [evidence:${evidence}]`, () => {
    expect(() =>
      assertFeedEventBookmarkUrls({
        node: { kind: 'bookmark', url: 'https://example.com/y' },
      }),
    ).not.toThrow();
  });

  it(`[regression] rejects target-bearing redacted bookmarks while projection strips targets [evidence:${evidence}]`, () => {
    expect(() =>
      assertFeedEventBookmarkUrls({
        node: { kind: 'bookmark', redacted: true, url: 'https://user:x@host/y' },
      }),
    ).toThrow(/url/i);
    const node = projectFeedNodeBookmark({
      id: 'n',
      kind: 'bookmark',
      redacted: true,
      url: 'https://user:x@host/y',
    });
    expect(node).toEqual({ id: 'n', kind: 'bookmark', redacted: true });
  });
});
