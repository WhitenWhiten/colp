import { describe, expect, it, vi } from 'vitest';

import type { Operation } from '../../src/types/index.js';
import { assertEffectBinding } from '../../src/sync/authoritative-effect-kind.js';
import { encodeCanonicalJson } from '../../src/sync/canonical.js';
import { AUTHORITATIVE_EFFECT_MAX_BYTES } from '../../src/sync/index.js';
import {
  WRONG_DIGEST,
  binding,
  evidence,
  fixture,
  folderNode,
  operationBase,
  seal,
  urlHashOf,
  type EffectKind,
} from './authoritative-effect-binding-fixture.js';

describe(`assertEffectBinding ${evidence}`, () => {
  it.each<EffectKind>([
    'create_node', 'update_node_content', 'move_node',
    'delete_node', 'delete_subtree', 'restore_node',
  ])('accepts a sealed %s effect', (type) => {
    const { operation, effect } = fixture(type);
    expect(binding(operation, effect)).not.toThrow();
  });

  it.each([
    ['opId', { opId: 'op-x' }],
    ['replicaId', { replicaId: 'replica-x' }],
    ['sequence', { sequence: 8 }],
    ['collectionId', { collectionId: 'collection-x' }],
  ] as const)('rejects an effect whose %s leaves the Operation binding', (_field, override) => {
    const { operation, effect } = fixture('move_node');
    expect(binding(operation, { ...effect, ...override }))
      .toThrow(/does not match its source Operation binding/);
  });

  it.each([
    ['effect kind', 'node_moved'],
    ['missing kind', undefined],
  ])('rejects a create_node Operation bound to a %s effect', (_label, kind) => {
    const { operation } = fixture('create_node');
    const moved = fixture('move_node').effect as unknown as Record<string, unknown>;
    const draft: Record<string, unknown> = { ...moved, kind };
    if (kind === undefined) delete draft.kind;
    expect(binding(operation, draft)).toThrow(/kind does not match its Operation type/);
  });

  it('rejects an Operation type outside the closed effect-kind map', () => {
    const operation = {
      ...operationBase, type: 'update_annotation', targetId: 'annotation-1',
      baseRevision: 'r-8', payload: { base: { text: 'a' }, value: { text: 'b' } },
    } as unknown as Operation;
    expect(binding(operation, fixture('delete_node').effect))
      .toThrow(/kind does not match its Operation type/);
    const { effect } = fixture('delete_subtree');
    const { kind: _kind, ...kindless } = effect as unknown as Record<string, unknown>;
    expect(binding(operation, kindless)).toThrow(/kind does not match its Operation type/);
  });

  describe('RFC 9530 digest shape', () => {
    const malformed = [
      'sha-256=:bad=:',
      `sha-256=:${'A'.repeat(42)}=:`,
      `sha-256=:${'A'.repeat(44)}=:`,
      `sha-256=:${'A'.repeat(42)}!=:`,
      `sha-256=:${'A'.repeat(43)}=:tail`,
      `xsha-256=:${'A'.repeat(43)}=:`,
      'sha-256=:A=:',
      `sha-256=:${'A'.repeat(43)}=`,
      42,
      null,
    ];
    it.each(malformed)('rejects malformed operationDigest %j', (value) => {
      const { operation, effect } = fixture('move_node');
      const draft = { ...seal(operation, effect), operationDigest: value };
      expect(() => assertEffectBinding(operation, draft as never, undefined, undefined, vi.fn()))
        .toThrow(/operationDigest must be an RFC 9530 sha-256 digest/);
    });
    it.each(malformed)('rejects malformed effectDigest %j', (value) => {
      const { operation, effect } = fixture('move_node');
      const draft = { ...seal(operation, effect), effectDigest: value };
      expect(() => assertEffectBinding(operation, draft as never, undefined, undefined, vi.fn()))
        .toThrow(/effectDigest must be an RFC 9530 sha-256 digest/);
    });
    it('rejects a well-formed but wrong operationDigest', () => {
      const { operation, effect } = fixture('move_node');
      const draft = { ...seal(operation, effect), operationDigest: WRONG_DIGEST };
      expect(() => assertEffectBinding(operation, draft, undefined, undefined, vi.fn()))
        .toThrow(/operationDigest does not match the canonical Operation/);
    });
    it('rejects a well-formed but wrong effectDigest', () => {
      const { operation, effect } = fixture('move_node');
      const draft = { ...seal(operation, effect), effectDigest: WRONG_DIGEST };
      expect(() => assertEffectBinding(operation, draft, undefined, undefined, vi.fn()))
        .toThrow(/effectDigest does not match the canonical effect/);
    });
  });

  describe('effect budgets', () => {
    const byteLength = (effect: object) =>
      Buffer.byteLength(encodeCanonicalJson(effect, 'test'), 'utf8');

    function sizedEffect(title: string): { operation: Operation; draft: Record<string, unknown> } {
      const { operation, effect } = fixture('create_node');
      return {
        operation,
        draft: { ...(effect as unknown as Record<string, unknown>),
          node: { ...folderNode, title } },
      };
    }

    it('accepts an effect at exactly the byte budget and rejects one byte over', () => {
      const probe = sizedEffect('');
      const sealed = seal(probe.operation, probe.draft);
      const delta = AUTHORITATIVE_EFFECT_MAX_BYTES - byteLength(sealed);
      expect(delta).toBeGreaterThan(0);

      const exact = sizedEffect('x'.repeat(delta));
      const sealedExact = seal(exact.operation, exact.draft);
      expect(byteLength(sealedExact)).toBe(AUTHORITATIVE_EFFECT_MAX_BYTES);
      expect(() => assertEffectBinding(exact.operation, sealedExact, undefined, undefined, vi.fn()))
        .not.toThrow();

      const over = sizedEffect('x'.repeat(delta + 1));
      expect(() => assertEffectBinding(over.operation, seal(over.operation, over.draft), undefined, undefined, vi.fn()))
        .toThrow(RangeError);
      expect(binding(over.operation, over.draft)).toThrow(/byte budget/);
    });

    it('rejects an effect deeper than the authoritative depth budget', () => {
      const { operation, effect } = fixture('create_node');
      let nested: Record<string, unknown> = {};
      for (let depth = 0; depth < 40; depth += 1) nested = { nested };
      // Placeholder digests keep the draft seal-free: the depth guard must fire
      // before the canonical digest comparisons.
      const draft = { ...(effect as unknown as Record<string, unknown>), extension: nested };
      expect(() => assertEffectBinding(operation, draft as never, undefined, undefined, vi.fn()))
        .toThrow(/Authoritative Pull effect exceeds the maximum JSON depth/);
    });
  });

  describe('node domain rules', () => {
    it('rejects a Node that is its own parent', () => {
      const { operation, effect } = fixture('update_node_content');
      const draft = { ...(effect as object), node: { ...folderNode, parentId: 'node-1' } };
      expect(binding(operation, draft)).toThrow(/own parent/);
    });

    it('rejects a Bookmark urlHash that does not match its URL', () => {
      const { operation, effect } = fixture('update_node_content');
      const bookmark = {
        ...folderNode, kind: 'bookmark' as const, url: 'https://example.com/',
        urlHash: urlHashOf('https://example.com/'),
      };
      expect(binding(operation, { ...(effect as object), node: bookmark })).not.toThrow();
      const wrong = { ...bookmark, urlHash: urlHashOf('https://other.example/') };
      expect(binding(operation, { ...(effect as object), node: wrong }))
        .toThrow(/urlHash does not match/);
    });
  });
});
