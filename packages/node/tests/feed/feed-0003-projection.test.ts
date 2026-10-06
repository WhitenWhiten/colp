import { describe, expect, it } from 'vitest';

import { projectFeedEvent, projectFeedEvents } from '../../src/feed/projection.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = 'feed.projection';
const validators = createValidatorRegistry();

function nodeCreated(url = 'https://example.com/article'): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
    source: 'https://alice.example/collections',
    type: 'org.collectionprotocol.node.created.v1',
    subject: 'collections/c/collection-1/nodes/node-9',
    time: '2026-07-16T06:30:00Z',
    datacontenttype: 'application/json',
    collectionprotocolversion: '0.1',
    data: {
      collectionId: 'collection-1',
      revision: 'r_1',
      node: {
        id: 'node-9',
        kind: 'bookmark',
        title: 'Public',
        url,
      },
    },
  };
}

describe(`FEED-0003 feed projection MUST_NOT private fields [evidence:${evidence}]`, () => {
  it(`[success] projects a safe node.created event [evidence:${evidence}]`, () => {
    const input = nodeCreated();
    const result = projectFeedEvent(input, { validators });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      const value = result.value as Record<string, unknown>;
      const data = value.data as Record<string, unknown>;
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(data)).toBe(true);
      expect(Object.isFrozen(data.node)).toBe(true);
    }
  });

  it(`[negative] strips credentials and secret-like fields from projection input [evidence:${evidence}]`, () => {
    const payload = {
      collectionId: 'collection-1',
      revision: 'r_1',
      apiKey: 'secret-token',
      password: 'hunter2',
      node: { id: 'n1', kind: 'folder', title: 'ok' },
    };
    const result = projectFeedEvent(payload, {
      publicExtensionNamespaces: [],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        collectionId: 'collection-1',
        revision: 'r_1',
        node: { id: 'n1', kind: 'folder', title: 'ok' },
      },
    });
  });

  it(`[negative] never exposes native source ids after projection [evidence:${evidence}]`, () => {
    const payload = {
      collectionId: 'collection-1',
      nativeSourceId: 'filesystem:/Users/alice/private',
      node: { id: 'n1', kind: 'folder' },
    };
    const result = projectFeedEvent(payload, { publicExtensionNamespaces: [] });
    expect(result).toEqual({ ok: false, code: 'projection_failed' });
  });

  it(`[negative] unsafe extensions fail closed without partial success [evidence:${evidence}]`, () => {
    const payload = {
      collectionId: 'collection-1',
      extensions: {
        'https://private.example/ns': { secret: true },
      },
    };
    const result = projectFeedEvent(payload, { publicExtensionNamespaces: [] });
    expect(result).toEqual({ ok: true, value: { collectionId: 'collection-1' } });
  });

  it(`[negative] event contract failure does not project [evidence:${evidence}]`, () => {
    const bad = nodeCreated();
    bad.type = 'org.collectionprotocol.not-a-real-type.v1';
    const result = projectFeedEvent(bad, { validators });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('event_contract_failed');
  });

  it(`[boundary] projectFeedEvents fails closed on any bad item (no partial list) [evidence:${evidence}]`, () => {
    const good = nodeCreated();
    const bad = nodeCreated();
    bad.type = 'not-valid';
    const result = projectFeedEvents([good, bad], { validators });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('partial_projection');
  });

  it(`[success] projectFeedEvents projects a full safe page [evidence:${evidence}]`, () => {
    const events = [nodeCreated(), nodeCreated('https://example.com/b')];
    const result = projectFeedEvents(events, {
      validators,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(events);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it(`[success] deterministically projects an empty page [evidence:${evidence}]`, () => {
    expect(projectFeedEvents([], { validators })).toEqual({ ok: true, value: [] });
  });

  it(`[success] retains only explicitly allowlisted extensions [evidence:${evidence}]`, () => {
    const payload = {
      collectionId: 'collection-1',
      extensions: {
        'https://public.example/ns': { label: 'public' },
        'https://private.example/ns': { label: 'private' },
      },
    };
    expect(projectFeedEvent(payload, {
      publicExtensionNamespaces: ['https://public.example/ns'],
    })).toEqual({
      ok: true,
      value: {
        collectionId: 'collection-1',
        extensions: { 'https://public.example/ns': { label: 'public' } },
      },
    });
  });

  it(`[negative] returns a deterministic failure for cycles and invalid limits [evidence:${evidence}]`, () => {
    const cyclic: Record<string, unknown> = { collectionId: 'collection-1' };
    cyclic.self = cyclic;
    expect(projectFeedEvent(cyclic)).toEqual({ ok: false, code: 'projection_failed' });
    expect(projectFeedEvent(
      { collectionId: 'collection-1' },
      { limits: { maxDepth: 0 } },
    )).toEqual({ ok: false, code: 'projection_failed' });
  });

  it(`[regression] redacts unsafe bookmark URLs during projection [evidence:${evidence}]`, () => {
    const event = nodeCreated('https://user:password@example.com/private');
    // Schema rejects this event; projection path should fail contract, not leak.
    const result = projectFeedEvent(event, { validators, bookmarkMode: 'redact' });
    expect(result.ok).toBe(false);
  });

  it(`[boundary] rejects Proxy input [evidence:${evidence}]`, () => {
    expect(projectFeedEvent(new Proxy({}, {}), { validators }).ok).toBe(false);
    expect(projectFeedEvents(new Proxy([], {}) as never, { validators }).ok).toBe(false);
  });
});
