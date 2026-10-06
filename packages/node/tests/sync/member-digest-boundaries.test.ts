import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalAuthoritativeMemberDigest, canonicalAuthoritativeEffectPageDigest,
  canonicalOperationDigest, validateAuthoritativePullEventPages,
} from '../../src/sync/index.js';
import type { AuthoritativeEffectPage } from '../../src/types/index.js';

const oracle = (members: readonly string[]) =>
  `sha-256=:${createHash('sha256').update(JSON.stringify(members)).digest('base64')}:`;

function series(members: string[]) {
  const pageCount = Math.ceil(members.length / 512);
  let previousPageDigest: string | null = null;
  const pages: AuthoritativeEffectPage[] = Array.from({ length: pageCount }, (_, index) => {
    const chunk = members.slice(index * 512, (index + 1) * 512);
    const input = { effectId: 'effect-1', pageNumber: index + 1, pageCount,
      members: chunk, memberCount: chunk.length, previousPageDigest, pageDigest: '' };
    const page = { ...input, pageDigest: canonicalAuthoritativeEffectPageDigest(input) };
    previousPageDigest = page.pageDigest;
    return page;
  });
  return { pages, reference: { effectId: 'effect-1', rootId: members[0]!, pageCount, memberCount: members.length,
    memberDigest: oracle(members), firstPageDigest: pages[0]!.pageDigest } };
}

describe('paged authoritative member digest boundaries', () => {
  it.each([0, 1, 512, 513, 10_000, 10_001, 524_288])('hashes %s members using the protocol framing', count => {
    const members = Array.from({ length: count }, (_, index) => `node-${index}`);
    expect(canonicalAuthoritativeMemberDigest(members)).toBe(oracle(members));
  });

  it('preserves Unicode, escapes and wire order', () => {
    const members = ['é', 'é', '😀', 'quote"', 'line\n', 'slash\\'];
    expect(canonicalAuthoritativeMemberDigest(members)).toBe(oracle(members));
    expect(canonicalAuthoritativeMemberDigest([...members].reverse())).not.toBe(oracle(members));
  });

  it('rejects series above the protocol bound without relaxing ordinary JSON', () => {
    expect(() => canonicalAuthoritativeMemberDigest(new Array(524_289))).toThrow(/maximum paged member count/);
    expect(() => canonicalOperationDigest(Array.from({ length: 10_001 }, () => 'node'))).toThrow();
  });

  it('does not evaluate array getters or serialization hooks', () => {
    const getter = vi.fn(() => 'node');
    const accessor = ['node'];
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter });
    expect(() => canonicalAuthoritativeMemberDigest(accessor)).toThrow(/data properties/);
    const toJSON = vi.fn(() => ['node']);
    expect(() => canonicalAuthoritativeMemberDigest(Object.assign(['node'], { toJSON }))).toThrow(/extra properties/);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('rejects subclasses and array-like objects at the ordinary-array boundary', () => {
    class Members extends Array<string> {}
    const arrayLike = Object.assign(Object.create(Array.prototype), { 0: 'node', length: 1 });
    for (const input of [new Members('node'), arrayLike]) {
      expect(() => canonicalAuthoritativeMemberDigest(input)).toThrow(/must be an ordinary array/);
    }
  });

  it('rejects non-enumerable member data instead of silently hashing it', () => {
    const members = ['node'];
    Object.defineProperty(members, '0', { value: 'node', enumerable: false });
    expect(() => canonicalAuthoritativeMemberDigest(members)).toThrow(/dense string data properties/);
  });

  it.each([null, {}, new Array(1), [1], [['node']], Object.assign(['node'], { extra: true })])('rejects non-member input %j', value => {
    expect(() => canonicalAuthoritativeMemberDigest(value)).toThrow();
  });

  it('validates a complete 20-page series above the old 10000-member limit', () => {
    const { pages, reference } = series(Array.from({ length: 10_001 }, (_, index) => `node-${index}`));
    expect(validateAuthoritativePullEventPages(pages, reference)).toHaveLength(20);
    expect(() => validateAuthoritativePullEventPages(pages.slice(1), reference)).toThrow(/incomplete/);
    expect(() => validateAuthoritativePullEventPages([...pages].reverse(), reference)).toThrow(/chain|binding/);
  });

  it('rejects a cross-page duplicate even with correct hashes', () => {
    const members = Array.from({ length: 513 }, (_, index) => `node-${index}`);
    members[512] = members[0]!;
    const { pages, reference } = series(members);
    expect(() => validateAuthoritativePullEventPages(pages, reference)).toThrow(/duplicate members/);
  });

  it.each([{ pageCount: 1_025 }, { memberCount: 524_289 }])('rejects oversized page authority %j', override => {
    const { pages, reference } = series(['root-1']);
    expect(() => validateAuthoritativePullEventPages(pages, { ...reference, ...override })).toThrow(/budget/);
  });
});
