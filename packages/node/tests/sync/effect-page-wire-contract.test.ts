import { describe, expect, it } from 'vitest';

import {
  EFFECT_PAGE_TEMPLATE_VARIABLES,
  expandAuthoritativeEffectPageUrl,
} from '../../src/sync/index.js';

describe('SYNC-Q-001 effect-page wire contract', () => {
  const template = 'https://sync.example/effects/{effectId}/pages/{pageNumber}';

  it('freezes URL variables as effectId and pageNumber only', () => {
    expect([...EFFECT_PAGE_TEMPLATE_VARIABLES]).toEqual(['effectId', 'pageNumber']);
    expect(expandAuthoritativeEffectPageUrl(template, 'effect-1', 20))
      .toBe('https://sync.example/effects/effect-1/pages/20');
  });

  it('rejects templates that copy Session or Replica identity into the URL', () => {
    for (const raw of [
      'https://sync.example/effects/{effectId}/pages/{pageNumber}?sessionId={sessionId}',
      'https://sync.example/effects/{effectId}/{pageNumber}/{collectionId}',
      'https://sync.example/effects/{effectId}/pages/{pageNumber}?replicaId={replicaId}',
    ]) {
      expect(() => expandAuthoritativeEffectPageUrl(raw, 'effect-1', 1)).toThrow(/effectId and pageNumber/i);
    }
  });
});
