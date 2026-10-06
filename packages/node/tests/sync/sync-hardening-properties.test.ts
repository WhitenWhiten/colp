/**
 * Property / hardening tests for Sync security-sensitive pure helpers:
 * Netscape HREF schemes, Tag OR-set merge, Snapshot URL private/local rejector.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  mergeSyncTagsObservedRemove,
  parseNetscapeBookmarkHtml,
  rejectPrivateOrLocalSnapshotUrl,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.hardening-properties]';
const NETSCAPE_MARKER = '<!DOCTYPE NETSCAPE-Bookmark-file-1>';

function netscapeWithHref(href: string): string {
  // Attribute values are quoted; keep the raw HREF text for scheme/entity cases.
  return [
    NETSCAPE_MARKER,
    '<TITLE>Bookmarks</TITLE>',
    '<DL><p>',
    `<DT><A HREF="${href}">Link</A>`,
    '</DL>',
  ].join('\n');
}

function orSetMembership(
  base: readonly string[],
  current: readonly string[],
  incoming: readonly string[],
): Set<string> {
  const baseSet = new Set(base);
  const incomingSet = new Set(incoming);
  const deleted = new Set<string>();
  for (const tag of baseSet) {
    if (!incomingSet.has(tag)) deleted.add(tag);
  }
  const result = new Set<string>();
  for (const tag of current) {
    if (!deleted.has(tag)) result.add(tag);
  }
  for (const tag of incoming) {
    if (!baseSet.has(tag)) result.add(tag);
  }
  return result;
}

describe(`Sync hardening properties ${evidence}`, () => {
  describe(`Netscape HREF scheme fail-closed ${evidence}`, () => {
    it(`rejects non-http(s) schemes for arbitrary scheme tokens ${evidence}`, () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'javascript',
            'data',
            'file',
            'vbscript',
            'about',
            'blob',
            'chrome',
            'mailto',
            'ftp',
            'ws',
            'wss',
          ),
          fc.string({ minLength: 0, maxLength: 24 }),
          (scheme, rest) => {
            // Avoid breaking out of the attribute via quotes.
            const safeRest = rest.replace(/["'<>\r\n]/gu, '');
            const href = `${scheme}:${safeRest}`;
            expect(() => parseNetscapeBookmarkHtml(netscapeWithHref(href))).toThrow(TypeError);
          },
        ),
        { numRuns: 40 },
      );
    });

    it(`accepts absolute http(s) HREFs with simple hosts and paths ${evidence}`, () => {
      fc.assert(
        fc.property(
          fc.constantFrom('http', 'https', 'HTTP', 'HTTPS'),
          fc.stringMatching(/^[a-z]{1,8}(?:\.[a-z]{2,6}){1,2}$/),
          fc.stringMatching(/^[a-z0-9/_-]{0,24}$/),
          (scheme, host, path) => {
            const href = `${scheme}://${host}/${path}`;
            const doc = parseNetscapeBookmarkHtml(netscapeWithHref(href));
            expect(doc.children).toHaveLength(1);
            const child = doc.children[0];
            expect(child).toMatchObject({ kind: 'bookmark' });
            if (child && child.kind === 'bookmark') {
              expect(child.url.toLowerCase().startsWith(`${scheme.toLowerCase()}://`)).toBe(true);
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it(`accepts scheme-less relative references without colon-before-slash ${evidence}`, () => {
      fc.assert(
        fc.property(
          fc.constantFrom('/path', 'foo/bar', '//cdn.example/x', '?q=1', '#frag', 'a-b_c'),
          (href) => {
            const doc = parseNetscapeBookmarkHtml(netscapeWithHref(href));
            expect(doc.children[0]).toMatchObject({ kind: 'bookmark', url: href });
          },
        ),
        { numRuns: 10 },
      );
    });
  });

  describe(`Tag OR-set membership ${evidence}`, () => {
    const tagArb = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0);
    const tagListArb = fc.uniqueArray(tagArb, { minLength: 0, maxLength: 6 });

    it(`matches OR-set membership: (current − deleted) ∪ added ${evidence}`, () => {
      fc.assert(
        fc.property(tagListArb, tagListArb, tagListArb, (base, current, incoming) => {
          const result = mergeSyncTagsObservedRemove({
            baseTags: base,
            currentTags: current,
            incomingTags: incoming,
          });
          expect(result.status).toBe('merged');
          if (result.status !== 'merged') return;
          const expected = orSetMembership(base, current, incoming);
          expect(new Set(result.tags)).toEqual(expected);
          // Deterministic order: sorted lexicographically.
          expect([...result.tags]).toEqual([...result.tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        }),
        { numRuns: 80 },
      );
    });

    it(`retains concurrent current-only tags that were never in base ${evidence}`, () => {
      fc.assert(
        fc.property(tagListArb, tagArb, (shared, concurrent) => {
          fc.pre(!shared.includes(concurrent));
          const result = mergeSyncTagsObservedRemove({
            baseTags: shared,
            currentTags: [...shared, concurrent],
            incomingTags: shared,
          });
          expect(result.status).toBe('merged');
          if (result.status !== 'merged') return;
          expect(result.tags).toContain(concurrent);
        }),
        { numRuns: 40 },
      );
    });

    it(`removes only base-observed tags that incoming drops ${evidence}`, () => {
      fc.assert(
        fc.property(tagArb, tagArb, (kept, removed) => {
          fc.pre(kept !== removed);
          const result = mergeSyncTagsObservedRemove({
            baseTags: [kept, removed],
            currentTags: [kept, removed],
            incomingTags: [kept],
          });
          expect(result.status).toBe('merged');
          if (result.status !== 'merged') return;
          expect(result.tags).toContain(kept);
          expect(result.tags).not.toContain(removed);
        }),
        { numRuns: 30 },
      );
    });
  });

  describe(`Snapshot URL private/local rejector ${evidence}`, () => {
    const privateIpv4 = fc.oneof(
      fc.tuple(fc.constant(0), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      fc.tuple(fc.constant(10), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      fc.tuple(fc.constant(127), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      fc.tuple(fc.constant(192), fc.constant(168), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      fc.tuple(fc.constant(169), fc.constant(254), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
    );

    it(`rejects dotted private/loopback/CGNAT IPv4 literals ${evidence}`, () => {
      fc.assert(
        fc.property(privateIpv4, ([a, b, c, d]) => {
          const url = new URL(`https://${a}.${b}.${c}.${d}/snapshot`);
          expect(() => rejectPrivateOrLocalSnapshotUrl(url)).toThrow(/private|local|localhost|snapshotUrl/i);
        }),
        { numRuns: 60 },
      );
    });

    it(`rejects mapped IPv6, ULA, link-local, and unspecified forms ${evidence}`, () => {
      const privateIpv6 = fc.constantFrom(
        '::',
        '::1',
        '::ffff:10.0.0.1',
        '::ffff:127.0.0.1',
        'fc00::1',
        'fd12:3456:789a::1',
        'fe80::1',
      );
      fc.assert(
        fc.property(privateIpv6, (host) => {
          expect(() => rejectPrivateOrLocalSnapshotUrl(new URL(`https://[${host}]/snapshot`))).toThrow(
            /private|local|localhost|snapshotUrl/i,
          );
        }),
        { numRuns: 30 },
      );
    });

    it(`rejects decimal and hexadecimal single-number encodings across private/local ranges ${evidence}`, () => {
      fc.assert(
        fc.property(privateIpv4, ([a, b, c, d]) => {
          const decimal = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
          const hexadecimal = `0x${decimal.toString(16)}`;
          for (const host of [String(decimal), hexadecimal]) {
            const url = new URL('https://public.example/snapshot');
            Object.defineProperty(url, 'hostname', { value: host });
            expect(() => rejectPrivateOrLocalSnapshotUrl(url)).toThrow(
              /private|local|localhost|snapshotUrl/i,
            );
          }
        }),
        { numRuns: 60 },
      );
    });

    it(`accepts public mapped IPv6 and single-number IPv4 counterexamples ${evidence}`, () => {
      expect(() => rejectPrivateOrLocalSnapshotUrl(
        new URL('https://[::ffff:8.8.8.8]/snapshot'),
      )).not.toThrow();

      const publicSingleNumber = new URL('https://public.example/snapshot');
      const publicIpv4 = 8 * 2 ** 24 + 8 * 2 ** 16 + 8 * 2 ** 8 + 8;
      Object.defineProperty(publicSingleNumber, 'hostname', { value: String(publicIpv4) });
      expect(() => rejectPrivateOrLocalSnapshotUrl(publicSingleNumber)).not.toThrow();
    });

    it(`rejects localhost hostnames ${evidence}`, () => {
      for (const host of ['localhost', 'app.localhost', 'LOCALHOST']) {
        expect(() => rejectPrivateOrLocalSnapshotUrl(new URL(`https://${host}/x`))).toThrow(
          /private|local|localhost|snapshotUrl/i,
        );
      }
    });

    it(`accepts typical public hostnames without DNS I/O ${evidence}`, () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-z]{3,10}\.(?:example|test|invalid)$/),
          (host) => {
            expect(() => rejectPrivateOrLocalSnapshotUrl(new URL(`https://${host}/snap`))).not.toThrow();
          },
        ),
        { numRuns: 20 },
      );
    });
  });
});
