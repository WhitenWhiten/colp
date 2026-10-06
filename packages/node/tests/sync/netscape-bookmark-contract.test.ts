import { describe, expect, it } from 'vitest';

import {
  parseNetscapeBookmarkHtml,
  type NetscapeBookmarkDocument,
} from '../../src/sync/index.js';
import { parseNetscapeBookmarkHtml as parseFromModule } from '../../src/sync/netscape-bookmark.js';

const evidence = '[evidence:sync.netscape-bookmark]';
const NETSCAPE_MARKER = '<!DOCTYPE NETSCAPE-Bookmark-file-1>';

describe(`SYNC-0020 NETSCAPE-Bookmark-file-1 production parser ${evidence}`, () => {
  it(`exports the same parser from the Sync package surface and module ${evidence}`, () => {
    expect(typeof parseNetscapeBookmarkHtml).toBe('function');
    expect(parseNetscapeBookmarkHtml).toBe(parseFromModule);
  });

  it(`recognizes the standard marker and maps nested DL/DT folders and anchors ${evidence}`, () => {
    const document = [
      NETSCAPE_MARKER,
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<DL><p>',
      '<DT><H3>Reading</H3>',
      '<DL><p><DT><A HREF="https://example.test/?a=1&amp;b=2">A &amp; B</A></DL>',
      '<DT><A HREF="https://example.test/root">Root</A>',
      '</DL>',
    ].join('\n');

    const parsed: NetscapeBookmarkDocument = parseNetscapeBookmarkHtml(document);

    expect(parsed).toEqual({
      kind: 'folder',
      title: 'Bookmarks',
      children: [
        {
          kind: 'folder',
          title: 'Reading',
          children: [{ kind: 'bookmark', title: 'A & B', url: 'https://example.test/?a=1&b=2' }],
        },
        { kind: 'bookmark', title: 'Root', url: 'https://example.test/root' },
      ],
    });
  });

  it(`decodes HTML entities in titles and HREF values ${evidence}`, () => {
    const document = [
      NETSCAPE_MARKER,
      '<DL><p>',
      '<DT><A HREF="https://example.test/q?x=1&amp;y=2&amp;z=&quot;q&quot;">A &lt;B&gt; &amp; &#39;C&#39;</A>',
      '</DL>',
    ].join('\n');

    const parsed = parseNetscapeBookmarkHtml(document);
    const bookmark = parsed.children[0];

    expect(bookmark).toMatchObject({
      kind: 'bookmark',
      title: `A <B> & 'C'`,
      url: 'https://example.test/q?x=1&y=2&z="q"',
    });
  });

  it(`keeps empty valid documents empty ${evidence}`, () => {
    expect(parseNetscapeBookmarkHtml(`${NETSCAPE_MARKER}\n<DL><p></DL>`)).toEqual({
      kind: 'folder',
      title: 'Bookmarks',
      children: [],
    });
  });

  it(`rejects a document missing the NETSCAPE-Bookmark-file-1 marker ${evidence}`, () => {
    expect(() => parseNetscapeBookmarkHtml('<!DOCTYPE html><DL><p></DL>'))
      .toThrow(/NETSCAPE-Bookmark-file-1/u);
  });

  it(`rejects boundary anchors with an absent or empty HREF ${evidence}`, () => {
    expect(() => parseNetscapeBookmarkHtml(`${NETSCAPE_MARKER}<DL><p><A>missing</A></DL>`))
      .toThrow(/non-empty HREF/u);
    expect(() => parseNetscapeBookmarkHtml(`${NETSCAPE_MARKER}<DL><p><A HREF="">empty</A></DL>`))
      .toThrow(/non-empty HREF/u);
  });

  it(`accepts absolute http and https bookmark HREFs ${evidence}`, () => {
    const document = [
      NETSCAPE_MARKER,
      '<DL><p>',
      '<DT><A HREF="https://example.test/secure">Secure</A>',
      '<DT><A HREF="http://example.test/plain">Plain</A>',
      '<DT><A HREF="HTTPS://example.test/mixed">Mixed</A>',
      '</DL>',
    ].join('\n');

    const parsed = parseNetscapeBookmarkHtml(document);

    expect(parsed.children).toEqual([
      { kind: 'bookmark', title: 'Secure', url: 'https://example.test/secure' },
      { kind: 'bookmark', title: 'Plain', url: 'http://example.test/plain' },
      { kind: 'bookmark', title: 'Mixed', url: 'HTTPS://example.test/mixed' },
    ]);
  });

  it(`accepts scheme-less relative HREFs per production allow-list ${evidence}`, () => {
    // Production allows path-absolute / path-relative / protocol-relative / query / fragment relatives.
    const document = [
      NETSCAPE_MARKER,
      '<DL><p>',
      '<DT><A HREF="/local/path">Path absolute</A>',
      '<DT><A HREF="relative/page">Path relative</A>',
      '<DT><A HREF="//cdn.example.test/x">Protocol relative</A>',
      '<DT><A HREF="?q=1">Query only</A>',
      '<DT><A HREF="#frag">Fragment only</A>',
      '</DL>',
    ].join('\n');

    const parsed = parseNetscapeBookmarkHtml(document);

    expect(parsed.children).toEqual([
      { kind: 'bookmark', title: 'Path absolute', url: '/local/path' },
      { kind: 'bookmark', title: 'Path relative', url: 'relative/page' },
      { kind: 'bookmark', title: 'Protocol relative', url: '//cdn.example.test/x' },
      { kind: 'bookmark', title: 'Query only', url: '?q=1' },
      { kind: 'bookmark', title: 'Fragment only', url: '#frag' },
    ]);
  });

  it.each([
    [':foo', 'leading colon'],
    ['1http:x', 'digit-led colon form'],
    ['://evil.example', 'empty-scheme // form'],
  ] as const)(
    `rejects colon-before-path HREF trick %s (%s) fail-closed ${evidence}`,
    (href, _label) => {
      expect(() =>
        parseNetscapeBookmarkHtml(
          `${NETSCAPE_MARKER}<DL><p><DT><A HREF="${href}">Bad</A></DL>`,
        ),
      ).toThrow(/http\(s\) HREFs/u);
    },
  );

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hi'],
    ['file:', 'file:///etc/passwd'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['about:', 'about:blank'],
  ] as const)(
    `rejects non-http(s) HREF scheme %s fail-closed ${evidence}`,
    (_label, href) => {
      expect(() =>
        parseNetscapeBookmarkHtml(
          `${NETSCAPE_MARKER}<DL><p><DT><A HREF="${href}">Bad</A></DL>`,
        ),
      ).toThrow(/http\(s\) HREFs/u);
    },
  );

  it(`rejects HREF whose scheme remains dangerous after HTML entity decode ${evidence}`, () => {
    // Scheme check runs on the post-decode value (entities must not bypass the allow-list).
    expect(() =>
      parseNetscapeBookmarkHtml(
        `${NETSCAPE_MARKER}<DL><p><DT><A HREF="javascript:alert(&quot;xss&quot;)">X</A></DL>`,
      ),
    ).toThrow(/http\(s\) HREFs/u);

    expect(() =>
      parseNetscapeBookmarkHtml(
        `${NETSCAPE_MARKER}<DL><p><DT><A HREF="data:text/html,&lt;script&gt;">X</A></DL>`,
      ),
    ).toThrow(/http\(s\) HREFs/u);

    // Numeric character references for ":" must decode before the scheme check.
    expect(() =>
      parseNetscapeBookmarkHtml(
        `${NETSCAPE_MARKER}<DL><p><DT><A HREF="javascript&#58;alert(1)">X</A></DL>`,
      ),
    ).toThrow(/http\(s\) HREFs/u);

    expect(() =>
      parseNetscapeBookmarkHtml(
        `${NETSCAPE_MARKER}<DL><p><DT><A HREF="javascript&#x3a;alert(1)">X</A></DL>`,
      ),
    ).toThrow(/http\(s\) HREFs/u);

    for (const href of ['javascript&colon;alert(1)', 'java&Tab;script&colon;alert(1)',
      'java&#10;script:alert(1)']) {
      expect(() => parseNetscapeBookmarkHtml(
        `${NETSCAPE_MARKER}<DL><A HREF="${href}">X</A></DL>`,
      )).toThrow(/http\(s\) HREFs/u);
    }
  });

  it('decodes entities once and reads only a real HREF attribute', () => {
    for (const attrs of ['data-href="https://example.test"', `TITLE='HREF="https://example.test"'`]) {
      expect(() => parseNetscapeBookmarkHtml(`${NETSCAPE_MARKER}<A ${attrs}>X</A>`)).toThrow(/HREF/u);
    }
    const doc = parseNetscapeBookmarkHtml(`${NETSCAPE_MARKER}<A data-href="javascript:bad"
      TITLE="a > b" HREF="https://example.test/?q=&amp;#58;&amp;x=&colon;">A &amp;#58;</A>`);
    expect(doc.children[0]).toEqual({ kind: 'bookmark', title: 'A &#58;',
      url: 'https://example.test/?q=&#58;&x=:' });
  });

  it(`parses nested folders that only carry safe HREFs ${evidence}`, () => {
    const document = [
      NETSCAPE_MARKER,
      '<DL><p>',
      '<DT><H3>Outer</H3>',
      '<DL><p>',
      '<DT><H3>Inner</H3>',
      '<DL><p>',
      '<DT><A HREF="https://example.test/nested">Nested</A>',
      '<DT><A HREF="/rel/ok">Relative ok</A>',
      '</DL>',
      '</DL>',
      '</DL>',
    ].join('\n');

    const parsed = parseNetscapeBookmarkHtml(document);

    expect(parsed).toEqual({
      kind: 'folder',
      title: 'Bookmarks',
      children: [
        {
          kind: 'folder',
          title: 'Outer',
          children: [
            {
              kind: 'folder',
              title: 'Inner',
              children: [
                { kind: 'bookmark', title: 'Nested', url: 'https://example.test/nested' },
                { kind: 'bookmark', title: 'Relative ok', url: '/rel/ok' },
              ],
            },
          ],
        },
      ],
    });
  });

  it(`handles malformed-ish unbalanced DL without hang (fail-closed, non-fragile) ${evidence}`, () => {
    // Unbalanced open DL: parser must complete and return a folder tree (structure not over-asserted).
    const unbalancedOpen = parseNetscapeBookmarkHtml(
      `${NETSCAPE_MARKER}<DL><p><DT><A HREF="https://example.test/a">A</A>`,
    );
    expect(unbalancedOpen.kind).toBe('folder');
    expect(Array.isArray(unbalancedOpen.children)).toBe(true);
    expect(
      unbalancedOpen.children.some(
        (child) => child.kind === 'bookmark' && child.url === 'https://example.test/a',
      ),
    ).toBe(true);

    // Extra closing DL: must not throw or hang when stack is already at root.
    const extraClose = parseNetscapeBookmarkHtml(
      `${NETSCAPE_MARKER}<DL><p><DT><A HREF="https://example.test/b">B</A></DL></DL></DL>`,
    );
    expect(extraClose.kind).toBe('folder');
    expect(Array.isArray(extraClose.children)).toBe(true);
    expect(
      extraClose.children.some(
        (child) => child.kind === 'bookmark' && child.url === 'https://example.test/b',
      ),
    ).toBe(true);
  });
});
