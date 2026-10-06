import { describe, expect, it } from 'vitest';

import {
  assertFeedEventBookmarkUrls,
  assertNonRedactedFeedBookmarkUrl,
  assertRedactedFeedBookmarkShape,
  projectFeedNodeBookmark,
} from '../../src/feed/bookmark-url.js';
import { discriminateFeedEvent } from '../../src/feed/event-contracts.js';
import { projectFeedEvent } from '../../src/feed/projection.js';
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from '../../src/schema/index.js';
import type { FeedNode } from '../../src/types/index.js';

const evidence = 'feed.bookmark-url-safety';
const validators = createValidatorRegistry();
const permissiveValidators = {
  definitionNames: ['feedEvent'],
  get: () => {
    throw new Error('The permissive test registry does not compile validators.');
  },
  validate: () => ({ valid: true, errors: [] }),
} as unknown as ValidatorRegistry;
const nodeChangedTypes = [
  'org.collectionprotocol.node.created.v1',
  'org.collectionprotocol.node.updated.v1',
  'org.collectionprotocol.node.moved.v1',
] as const;

const generatedRedactedFeedNode: FeedNode = {
  id: 'node-9',
  kind: 'bookmark',
  redacted: true,
};

function nodeChangedEvent(
  type: (typeof nodeChangedTypes)[number],
  node: Record<string, unknown>,
): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
    source: 'https://alice.example/collections',
    type,
    subject: 'collections/c/collection-1/nodes/node-9',
    time: '2026-07-16T06:30:00Z',
    datacontenttype: 'application/json',
    collectionprotocolversion: '0.1',
    data: {
      collectionId: 'collection-1',
      revision: 'revision-1',
      node,
    },
  };
}

function expectNoBookmarkTargetFields(value: unknown): void {
  expect(value).not.toHaveProperty('url');
  expect(value).not.toHaveProperty('canonicalUrl');
  expect(value).not.toHaveProperty('urlHash');
}

describe(`CFI-006 redacted Feed Bookmark contract [evidence:${evidence}]`, () => {
  it.each(nodeChangedTypes)(
    `[negative] rejects a redacted Bookmark with a safe HTTP URL in complete %s event [evidence:${evidence}]`,
    (type) => {
      const event = nodeChangedEvent(type, {
        id: 'node-9',
        kind: 'bookmark',
        redacted: true,
        url: 'https://example.com/private',
      });

      expect(validators.validate('feedEvent', event).valid).toBe(false);
      const result = discriminateFeedEvent(event, validators);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.path).toMatch(/^\/data\/node(?:\/url)?$/u);
    },
  );

  it(`[negative] discriminator independently enforces the shared redacted shape rule [evidence:${evidence}]`, () => {
    const event = nodeChangedEvent('org.collectionprotocol.node.created.v1', {
      id: 'node-9',
      kind: 'bookmark',
      redacted: true,
      url: 'https://example.com/private',
    });

    expect(discriminateFeedEvent(event, permissiveValidators)).toEqual({
      valid: false,
      code: 'unsafe_bookmark_url',
      path: '/data/node/url',
    });
  });

  it.each([
    'javascript:alert(1)',
    'file:///C:/Users/Alice/private.html',
    'https://user:password@example.com/private',
  ])(
    `[negative] keeps Schema and URL guard rejection for dangerous target %s [evidence:${evidence}]`,
    (url) => {
      const event = nodeChangedEvent('org.collectionprotocol.node.created.v1', {
        id: 'node-9',
        kind: 'bookmark',
        redacted: true,
        url,
      });

      expect(validators.validate('feedEvent', event).valid).toBe(false);
      expect(discriminateFeedEvent(event, validators).valid).toBe(false);
      expect(() =>
        assertNonRedactedFeedBookmarkUrl({ kind: 'bookmark', url }),
      ).toThrow(/unsafe/i);
    },
  );

  it.each([
    ['url', 'https://example.com/private'],
    ['canonicalUrl', 'https://example.com/private'],
    ['urlHash', 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:'],
  ] as const)(
    `[negative] rejects redacted wide assertion input carrying %s [evidence:${evidence}]`,
    (field, target) => {
      const node = { kind: 'bookmark', redacted: true, [field]: target };
      expect(() => assertRedactedFeedBookmarkShape(node)).toThrow(field);
      expect(() => assertFeedEventBookmarkUrls({ node })).toThrow(field);
    },
  );

  it(`[negative] rejects an own target field even when its value is undefined [evidence:${evidence}]`, () => {
    const node = { kind: 'bookmark', redacted: true, url: undefined };
    expect(() => assertRedactedFeedBookmarkShape(node)).toThrow('url');
    expect(() => assertFeedEventBookmarkUrls({ node })).toThrow('url');
  });

  it(`[success] accepts a redacted Bookmark with no target fields through every contract [evidence:${evidence}]`, () => {
    const node = structuredClone(generatedRedactedFeedNode) as unknown as Record<string, unknown>;
    const event = nodeChangedEvent('org.collectionprotocol.node.created.v1', node);

    expect(() => assertRedactedFeedBookmarkShape(node)).not.toThrow();
    expect(() => assertFeedEventBookmarkUrls({ node })).not.toThrow();
    expect(validators.validate('feedNode', node)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('feedEvent', event)).toEqual({ valid: true, errors: [] });
    expect(discriminateFeedEvent(event, validators).valid).toBe(true);
  });

  it(`[boundary] validates the feedNode conditional contract directly [evidence:${evidence}]`, () => {
    const safeTarget = {
      id: 'node-9',
      kind: 'bookmark',
      url: 'https://example.com/public',
    };
    const redactedTarget = { ...safeTarget, redacted: true };

    expect(validators.validate('feedNode', safeTarget)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('feedNode', redactedTarget).valid).toBe(false);
  });

  it(`[success] strips every target field from an already-redacted projection input [evidence:${evidence}]`, () => {
    const projected = projectFeedNodeBookmark({
      id: 'node-9',
      kind: 'bookmark',
      title: 'Private target',
      redacted: true,
      url: 'https://example.com/private',
      canonicalUrl: 'https://example.com/canonical-private',
      urlHash: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    });

    expect(projected).toEqual({
      id: 'node-9',
      kind: 'bookmark',
      title: 'Private target',
      redacted: true,
    });
    expectNoBookmarkTargetFields(projected);
  });

  it(`[success] redact mode emits only a target-free summary for an unsafe target [evidence:${evidence}]`, () => {
    const node = {
      id: 'node-9',
      kind: 'bookmark',
      title: 'Private target',
      url: 'file:///C:/Users/Alice/private.html',
    };

    const projectedNode = projectFeedNodeBookmark(node, { mode: 'redact' });
    expect(projectedNode).toEqual({
      id: 'node-9',
      kind: 'bookmark',
      title: 'Private target',
      redacted: true,
    });
    expectNoBookmarkTargetFields(projectedNode);

    const result = projectFeedEvent(
      { collectionId: 'collection-1', revision: 'revision-1', node },
      { bookmarkMode: 'redact' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const projected = result.value as Record<string, unknown>;
      expectNoBookmarkTargetFields(projected.node);
      expect(projected.node).toMatchObject({ redacted: true });
    }
  });
});
