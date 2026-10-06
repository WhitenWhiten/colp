import { describe, expect, it } from 'vitest';
import {
  NETSCAPE_BOOKMARK_FILE_MARKER as marker,
  NETSCAPE_BOOKMARK_LIMITS as limits,
  parseNetscapeBookmarkHtml as parse,
  type NetscapeBookmarkDocument,
} from '../../src/sync/netscape-bookmark.js';
import { scanNetscapeBookmarkTags } from '../../src/sync/netscape-bookmark-tags.js';
import { readNetscapeBookmarkHref } from '../../src/sync/netscape-bookmark-href.js';

function nested(depth: number): string {
  return marker + '<DL>' + '<H3>folder</H3><DL>'.repeat(depth)
    + '<A HREF="/bookmark">bookmark</A>' + '</DL>'.repeat(depth + 1);
}

describe('Netscape bookmark import security budgets', () => {
  it('accepts the exact ASCII input budget and rejects one extra byte', () => {
    const input = marker + ' '.repeat(limits.maxInputBytes - marker.length);
    expect(parse(input).children).toEqual([]);
    expect(() => parse(input + ' ')).toThrow(RangeError);
  });

  it('counts UTF-8 bytes rather than only JavaScript string length', () => {
    const input = marker + '界'.repeat(Math.floor(limits.maxInputBytes / 3) + 1);
    expect(input.length).toBeLessThan(limits.maxInputBytes);
    expect(() => parse(input)).toThrow(/byte budget/);
  });

  it('bounds bookmark and folder allocations', () => {
    const anchor = '<A HREF="/x">x</A>';
    expect(parse(marker + anchor.repeat(limits.maxNodes)).children).toHaveLength(limits.maxNodes);
    expect(() => parse(marker + anchor.repeat(limits.maxNodes + 1))).toThrow(/node budget/);
    expect(() => parse(marker + '<H3>f</H3>'.repeat(limits.maxNodes + 1))).toThrow(/node budget/);
  });

  it('accepts the maximum depth and freezes every folder and child list', () => {
    let folder: NetscapeBookmarkDocument = parse(nested(limits.maxDepth));
    for (let depth = 0; depth <= limits.maxDepth; depth += 1) {
      expect(Object.isFrozen(folder)).toBe(true);
      expect(Object.isFrozen(folder.children)).toBe(true);
      const child = folder.children[0]!;
      expect(Object.isFrozen(child)).toBe(true);
      if (child.kind !== 'folder') break;
      folder = child;
    }
  });

  it('rejects over-depth folders, even without a following DL', () => {
    expect(() => parse(nested(limits.maxDepth + 1))).toThrow(/depth budget/);
    expect(() => parse(marker + '<H3>f</H3><DL>'.repeat(limits.maxDepth)
      + '<H3>too deep</H3>')).toThrow(/depth budget/);
  });

  it('fails closed on long unterminated tags instead of re-searching each embedded tag', () => {
    expect(() => parse(marker + '<H3 a="x" '.repeat(10_000))).toThrow(/Unterminated/);
    expect(() => [...scanNetscapeBookmarkTags('<!-- unfinished')]).toThrow(/Unterminated/);
  });

  it('skips comments and respects quoted greater-than characters', () => {
    const document = parse(marker + '<!-- <A HREF="javascript:bad">bad</A> -->'
      + '<A TITLE="a > b" HREF="/safe?q=>">A &amp; B</A>');
    expect(document.children).toEqual([{ kind: 'bookmark', title: 'A & B', url: '/safe?q=>' }]);
  });

  it('does not mistake another attribute or its quoted value for HREF', () => {
    expect(readNetscapeBookmarkHref(' data-href="/wrong" title=" HREF=/wrong" HREF="/right"'))
      .toBe('/right');
    expect(readNetscapeBookmarkHref(" HREF='/single' ")).toBe('/single');
    expect(readNetscapeBookmarkHref(' HREF=/unquoted')).toBe('/unquoted');
    expect(readNetscapeBookmarkHref(' disabled HREF="/after-boolean"')).toBe('/after-boolean');
    expect(readNetscapeBookmarkHref(' '.repeat(100_000))).toBeUndefined();
    expect(() => readNetscapeBookmarkHref('title="x"' + ' '.repeat(100_000) + '='))
      .toThrow(TypeError);
  });

  it.each(['javascript:alert(1)', 'java&#x09;script:alert(1)', 'data:text/html,test', 'file:///etc/passwd'])
    ('retains executable/non-web HREF rejection: %s', href => {
      expect(() => parse(marker + `<A HREF="${href}">bad</A>`)).toThrow(TypeError);
    });
});
