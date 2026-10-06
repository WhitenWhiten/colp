import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mapFeedToJsonFeed } from '../../src/feed/json-feed.js';

const evidence = 'feed.json-feed';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

describe(`FEED-0005 JSON Feed 1.1 mapping [evidence:${evidence}]`, () => {
  it(`[success] maps public-feed fixture to JSON Feed 1.1 [evidence:${evidence}]`, async () => {
    const feed = JSON.parse(await readFile(resolve(fixturesRoot, 'public-feed.json'), 'utf8'));
    const result = mapFeedToJsonFeed(feed, {
      authors: [{ name: 'Alice', url: 'https://alice.example/' }],
      tags: ['design'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.version).toBe('https://jsonfeed.org/version/1.1');
      expect(result.document.feed_url).toBe(feed.feedUrl);
      expect(result.document.home_page_url).toBe(feed.collectionUrl);
      expect(result.document.items).toHaveLength(1);
      expect(result.document.items[0]!.id).toBe(feed.events[0].id);
      expect(result.document.items[0]!.url).toBe(
        'https://alice.example/collections/c/019b3ca2-8424-7cc2-9a61-4bf44c23f07a/releases/release-r_1042',
      );
      expect(result.document.items[0]!._collection_protocol.type).toBe(
        'org.collectionprotocol.release.published.v1',
      );
      expect(result.document._collection_protocol.nextCursor).toBe(feed.nextCursor);
      expect(result.document.authors?.[0]?.name).toBe('Alice');
    }
  });

  it(`[success] maps bookmark external_url only when safe [evidence:${evidence}]`, () => {
    const feed = {
      protocolVersion: '0.1',
      feedUrl: 'https://alice.example/collections/c/c1/feed',
      collectionUrl: 'https://alice.example/collections/c1',
      title: 'T',
      events: [
        {
          specversion: '1.0',
          id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
          source: 'https://alice.example/collections',
          type: 'org.collectionprotocol.node.created.v1',
          subject: 'collections/c/c1/nodes/n1',
          time: '2026-07-16T06:30:00Z',
          datacontenttype: 'application/json',
          collectionprotocolversion: '0.1',
          data: {
            collectionId: 'c1',
            revision: 'r1',
            node: {
              id: 'n1',
              kind: 'bookmark',
              title: 'Example',
              url: 'https://example.com/a',
            },
          },
        },
      ],
      nextCursor: 'c',
      hasMore: false,
      poll: {
        notBefore: '2026-07-16T06:35:00Z',
        recommendedAfterSeconds: 300,
      },
      hubs: [],
    };
    const result = mapFeedToJsonFeed(feed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.items[0]!.external_url).toBe('https://example.com/a');
    }

    const unsafe = structuredClone(feed);
    (unsafe.events[0]!.data as { node: { url: string } }).node.url =
      'https://user:pass@example.com/a';
    const unsafeResult = mapFeedToJsonFeed(unsafe);
    expect(unsafeResult).toEqual({ ok: false, code: 'malformed_feed' });
  });

  it(`[negative] rejects malformed feeds and non-HTTP feed URLs [evidence:${evidence}]`, () => {
    expect(mapFeedToJsonFeed(null)).toEqual({ ok: false, code: 'malformed_feed' });
    expect(
      mapFeedToJsonFeed({
        feedUrl: 'file:///tmp/feed',
        collectionUrl: 'https://example.com',
        title: 't',
        events: [],
      }),
    ).toEqual({ ok: false, code: 'unsafe_url' });
  });
});
