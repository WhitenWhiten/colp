import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mapFeedToAtom } from '../../src/feed/atom.js';

const evidence = 'feed.atom';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

describe(`FEED-0006 Atom 1.0 mapping [evidence:${evidence}]`, () => {
  it(`[success] maps public-feed fixture to Atom with stable entry ids [evidence:${evidence}]`, async () => {
    const feed = JSON.parse(await readFile(resolve(fixturesRoot, 'public-feed.json'), 'utf8'));
    const result = mapFeedToAtom(feed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.entries).toHaveLength(1);
      expect(result.document.entries[0]!.id).toBe(
        `urn:collectionprotocol:event:${feed.events[0].id}`,
      );
      expect(result.document.links.some((l) => l.rel === 'self')).toBe(true);
      expect(result.document.links.some((l) => l.rel === 'alternate')).toBe(true);
      expect(result.xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(result.xml).toContain(feed.events[0].id);
    }
  });

  it(`[success] bookmark external URL uses rel=related [evidence:${evidence}]`, () => {
    const feed = {
      feedUrl: 'https://alice.example/collections/c/c1/feed',
      collectionUrl: 'https://alice.example/collections/c1',
      title: 'T',
      events: [
        {
          specversion: '1.0',
          id: 'e1',
          source: 'https://alice.example/collections',
          type: 'com.know-n.colp.node.created.v1',
          subject: 'collections/c/c1/nodes/n1',
          time: '2026-07-16T06:30:00Z',
          datacontenttype: 'application/json',
          collectionprotocolversion: '0.1',
          data: {
            collectionId: 'c1',
            revision: 'r1',
            node: { id: 'n1', kind: 'bookmark', title: 'bookmark', url: 'https://example.com/a' },
          },
        },
      ],
    };
    const result = mapFeedToAtom(feed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const related = result.document.entries[0]!.links.find((l) => l.rel === 'related');
      expect(related?.href).toBe('https://example.com/a');
      const alternate = result.document.entries[0]!.links.find((l) => l.rel === 'alternate');
      expect(alternate?.href).toBe(feed.collectionUrl);
    }
  });

  it(`[negative] omits related link for unsafe bookmark URLs [evidence:${evidence}]`, () => {
    const feed = {
      feedUrl: 'https://alice.example/collections/c/c1/feed',
      collectionUrl: 'https://alice.example/collections/c1',
      title: 'T',
      events: [
        {
          specversion: '1.0',
          id: 'e1',
          source: 'https://alice.example/collections',
          type: 'com.know-n.colp.node.created.v1',
          subject: 'collections/c/c1/nodes/n1',
          time: '2026-07-16T06:30:00Z',
          datacontenttype: 'application/json',
          collectionprotocolversion: '0.1',
          data: {
            collectionId: 'c1',
            revision: 'r1',
            node: { id: 'n1', kind: 'bookmark', title: 'bookmark', url: 'https://user:x@example.com/a' },
          },
        },
      ],
    };
    const result = mapFeedToAtom(feed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.entries[0]!.links.some((l) => l.rel === 'related')).toBe(false);
      expect(result.xml).not.toContain('user:x');
    }
  });

  it(`[negative] rejects malformed feeds [evidence:${evidence}]`, () => {
    expect(mapFeedToAtom(null).ok).toBe(false);
    expect(
      mapFeedToAtom({
        feedUrl: 'not-http',
        collectionUrl: 'https://example.com',
        title: 't',
        events: [],
      }).ok,
    ).toBe(false);
  });

  it(`[regression] escapes XML special characters [evidence:${evidence}]`, () => {
    const feed = {
      feedUrl: 'https://alice.example/feed',
      collectionUrl: 'https://alice.example/',
      title: 'A & B <C>',
      events: [
        {
          specversion: '1.0',
          id: 'e1',
          source: 'https://alice.example/collections',
          type: 'com.know-n.colp.collection.updated.v1',
          subject: 'collections/c/c1',
          time: '2026-07-16T06:30:00Z',
          datacontenttype: 'application/json',
          collectionprotocolversion: '0.1',
          data: { collectionId: 'c1', revision: 'r1', summary: 'x < y & z' },
        },
      ],
    };
    const result = mapFeedToAtom(feed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.xml).toContain('A &amp; B &lt;C&gt;');
      expect(result.xml).toContain('x &lt; y &amp; z');
      expect(result.xml).toContain('<content>x &lt; y &amp; z</content>');
    }
  });
});
