import { describe, expect, it } from 'vitest';

import { declareWebSubHubs, withWebSubHubs } from '../../src/feed/websub.js';

const evidence = 'feed.websub';

describe(`FEED-0007 WebSub hub declaration [evidence:${evidence}]`, () => {
  it(`[success] declares HTTPS hubs [evidence:${evidence}]`, () => {
    const result = declareWebSubHubs(['https://hub.example/', 'https://hub2.example/path']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hubs).toEqual([
        { type: 'WebSub', url: 'https://hub.example/' },
        { type: 'WebSub', url: 'https://hub2.example/path' },
      ]);
    }
  });

  it(`[success] attaches hubs onto a feed document without mutation [evidence:${evidence}]`, () => {
    const feed = { title: 'T', hubs: [] as const };
    const result = withWebSubHubs(feed, ['https://hub.example/']);
    expect(result.ok).toBe(true);
    if (result.ok && 'feed' in result) {
      expect(result.feed.hubs).toEqual([{ type: 'WebSub', url: 'https://hub.example/' }]);
      expect(feed.hubs).toEqual([]);
    }
  });

  it(`[negative] rejects HTTP hubs and userinfo [evidence:${evidence}]`, () => {
    expect(declareWebSubHubs(['http://hub.example/'])).toEqual({
      ok: false,
      code: 'unsafe_hub_url',
    });
    expect(declareWebSubHubs(['https://user:pass@hub.example/'])).toEqual({
      ok: false,
      code: 'unsafe_hub_url',
    });
  });

  it(`[negative] rejects duplicates and empty URLs [evidence:${evidence}]`, () => {
    expect(declareWebSubHubs(['https://hub.example/', 'https://hub.example/'])).toEqual({
      ok: false,
      code: 'duplicate_hub',
    });
    expect(declareWebSubHubs([''])).toEqual({ ok: false, code: 'malformed_hub' });
  });

  it(`[boundary] empty hub list is valid (no hubs declared) [evidence:${evidence}]`, () => {
    const result = declareWebSubHubs([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hubs).toEqual([]);
  });
});
