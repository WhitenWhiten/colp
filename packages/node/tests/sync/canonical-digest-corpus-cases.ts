/**
 * Deterministic SYNC-Q-020 digest corpus (seeded nested/fuzz + Unicode + key order).
 */

import {
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
} from '../../src/sync/canonical.js';

export const CANONICAL_DIGEST_CORPUS_SEED = 20_260_830;
export const CANONICAL_DIGEST_CORPUS_COUNT = 1_000;

const operationTypes = [
  'create_node', 'update_node_content', 'move_node', 'delete_node', 'delete_subtree',
] as const;

export interface CanonicalDigestCorpusFile {
  readonly seed: number;
  readonly count: number;
  readonly digests: readonly string[];
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function nestedValue(random: () => number, depth: number, index: number): unknown {
  if (depth <= 0 || random() < 0.25) {
    const pick = random();
    if (pick < 0.2) return null;
    if (pick < 0.4) return random() > 0.5;
    if (pick < 0.6) return Math.round((random() - 0.5) * 10_000) / 10;
    if (pick < 0.8) return `v-${index}-${Math.floor(random() * 1_000)}`;
    return Math.floor(random() * 1_000);
  }
  if (random() < 0.35) {
    const length = 1 + Math.floor(random() * 4);
    return Array.from({ length }, (_, member) => nestedValue(random, depth - 1, index + member));
  }
  const keys = ['alpha', 'beta', 'gamma', 'delta', 'title', 'nested'];
  const start = Math.floor(random() * keys.length);
  const ordered = [...keys.slice(start), ...keys.slice(0, start)];
  const result: Record<string, unknown> = {};
  for (const key of ordered) {
    if (random() < 0.3) continue;
    result[key] = nestedValue(random, depth - 1, index);
  }
  if (Object.keys(result).length === 0) result.title = `leaf-${index}`;
  return result;
}

function operationCase(index: number, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: `op_${index.toString(16).padStart(8, '0')}`,
    replicaId: `replica_${index % 50}`,
    sequence: 1 + (index % 10_000),
    collectionId: 'collection-1',
    type: operationTypes[index % operationTypes.length],
    baseRevision: index % 5 === 0 ? null : `rev-${index}`,
    occurredAt: '2026-07-27T00:00:00Z',
    payload: { parentId: 'root-1', afterId: null, beforeId: null, node: { kind: 'folder', title }, ...extra },
  };
}

export function digestCorpusCase(index: number): string {
  const random = createRng(CANONICAL_DIGEST_CORPUS_SEED + index * 97_351);
  if (index < 800) {
    return canonicalOperationDigest(operationCase(
      index,
      `title-${index}`,
      { nested: nestedValue(random, 1 + (index % 4), index) as Record<string, unknown> },
    ) as never);
  }
  if (index < 850) {
    return canonicalOperationDigest(operationCase(index, `\u00e9-${index}`) as never);
  }
  if (index < 900) {
    return canonicalOperationDigest(operationCase(index, `e\u0301-${index}`) as never);
  }
  if (index < 940) {
    const pair = Math.floor(index / 2);
    const leftFirst = index % 2 === 0;
    const payload = leftFirst
      ? { z: pair, a: pair + 1, m: 'mid' }
      : { a: pair + 1, m: 'mid', z: pair };
    return canonicalOperationDigest(operationCase(pair, 'key-order', payload) as never);
  }
  if (index < 970) {
    const boundary = operationCase(index, 'boundary');
    boundary.opId = index % 2 === 0 ? 'x' : 'o'.repeat(128);
    boundary.replicaId = index % 3 === 0 ? 'r' : 'r'.repeat(128);
    return canonicalOperationDigest(boundary as never);
  }
  if (index < 985) {
    const members = Array.from({ length: 1 + (index % 16) }, (_, member) => `node-${index}-${member}`);
    return canonicalAuthoritativeMemberDigest(members);
  }
  if (index < 993) {
    return canonicalAuthoritativeEffectDigest({
      effectId: `effect-${index}`,
      status: 'applied',
      opId: `op_${index}`,
      replicaId: 'replica_1',
      sequence: index,
      collectionId: 'collection-1',
      operationDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      effectDigest: `sha-256=:${'B'.repeat(43)}=:` ,
      kind: 'node_deleted',
      extra: nestedValue(random, 2, index),
    } as never);
  }
  return canonicalAuthoritativeEffectPageDigest({
    effectId: `effect-${index}`,
    pageNumber: 1 + (index % 20),
    pageCount: 20,
    members: [`node-${index}`],
    memberCount: 1,
    pageDigest: `sha-256=:${'C'.repeat(43)}=:` ,
    previousPageDigest: index % 2 === 0 ? null : `sha-256=:${'D'.repeat(43)}=:` ,
  } as never);
}

export function buildCanonicalDigestCorpus(): CanonicalDigestCorpusFile {
  return {
    seed: CANONICAL_DIGEST_CORPUS_SEED,
    count: CANONICAL_DIGEST_CORPUS_COUNT,
    digests: Array.from({ length: CANONICAL_DIGEST_CORPUS_COUNT }, (_, index) => digestCorpusCase(index)),
  };
}
