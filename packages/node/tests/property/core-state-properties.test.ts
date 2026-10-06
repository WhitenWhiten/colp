import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCanonicalRequestDigest } from '../../src/publisher/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  enforceCredentialRestrictions,
  enforceRateLimit,
  evaluateEffectiveScopes,
  type AtomicRateLimitCharge,
  type AtomicRateLimitCeilingResult,
  type AtomicRateLimitPort,
  type AtomicRateLimitResult,
  type CredentialRestriction,
  type CredentialRestrictionPorts,
} from '../../src/security/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import { parseProtocolQuery } from '../../src/shared/query.js';
import {
  createSyncSession,
  terminateSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
} from '../../src/sync/index.js';
import {
  createSequenceState,
  decideSequence,
  recordSequenceResult,
} from '../../src/sync/legacy.js';
import type { AccessPolicy, PrincipalRef, ScopeName, Snapshot, StrictNode } from '../../src/types/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();
const forbiddenIJsonKeys = new Set(['__proto__', 'constructor', 'prototype']);

function toIJsonValue(value: fc.JsonValue): fc.JsonValue {
  if (typeof value === 'number') {
    return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
  }
  if (typeof value === 'string') return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toIJsonValue);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !forbiddenIJsonKeys.has(key))
    .map(([key, entry]) => [key.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'), toIJsonValue(entry!)]));
}
const scopes = ['collections:read', 'nodes:read', 'nodes:write', 'annotations:read'] as const satisfies readonly ScopeName[];
const user: PrincipalRef = { type: 'user', id: 'property-user' };

function policy(allowed: readonly ScopeName[], denied: readonly ScopeName[] = []): AccessPolicy {
  const entries: AccessPolicy['entries'] = [];
  if (allowed.length > 0) {
    entries.push({
      principal: user,
      effect: 'allow',
      scopes: [allowed[0] as ScopeName, ...allowed.slice(1)],
    });
  }
  if (denied.length > 0) {
    entries.push({
      principal: user,
      effect: 'deny',
      scopes: [denied[0] as ScopeName, ...denied.slice(1)],
    });
  }
  return {
    visibility: 'private',
    entries,
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'property-policy',
  };
}

function graphSnapshot(folderCount: number): Snapshot {
  const source = JSON.parse(readFileSync(
    resolve(fixturesRoot, 'collection-snapshot.json'),
    'utf8',
  )) as Snapshot;
  const root = structuredClone(source.nodes.find((node) => node.kind === 'root')) as StrictNode;
  const folderTemplate = {
    ...root,
    kind: 'folder',
    folderRole: 'custom',
    position: 'P',
  } as StrictNode;
  const folders = Array.from({ length: folderCount }, (_, index) => ({
    ...structuredClone(folderTemplate),
    id: `property-folder-${index}`,
    parentId: index === 0 ? root.id : `property-folder-${index - 1}`,
    position: `P${index}`,
    folderRole: 'custom' as const,
    title: `Folder ${index}`,
  })) as StrictNode[];
  const snapshot = {
    ...source,
    collection: { ...source.collection, rootNodeId: root.id },
    nodes: [root, ...folders],
    annotations: [],
    attachments: [],
    relations: [],
    tombstones: [],
    page: { nextCursor: null, hasMore: false, sequence: 1 },
  } as Snapshot;
  delete (snapshot as { contentDigest?: string }).contentDigest;
  return snapshot;
}

describe('Core property and state-machine invariants', () => {
  it('accepts arbitrary bounded parent chains and rejects an introduced cycle', () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 40 }), (folderCount) => {
      const valid = graphSnapshot(folderCount);
      expect(validateSnapshotSemantics(valid)).toEqual({ valid: true, issues: [] });

      const cyclic = structuredClone(valid);
      const mutableNodes = cyclic.nodes as unknown as Array<{ id: string; parentId: string | null }>;
      mutableNodes[1]!.parentId = mutableNodes[2]!.id;
      mutableNodes[2]!.parentId = mutableNodes[1]!.id;
      const result = validateSnapshotSemantics(cyclic);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.issues.some((issue) => issue.code === 'parent_cycle')).toBe(true);
    }), { numRuns: 80 });
  });

  it('round-trips opaque cursors and bounded limits without normalization', () => {
    const cursor = fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'), {
      minLength: 1,
      maxLength: 96,
    }).map((characters) => characters.join(''));
    fc.assert(fc.property(cursor, fc.integer({ min: 1, max: 200 }), (value, limit) => {
      const parsed = parseProtocolQuery(
        'cursorPageQuery',
        new URLSearchParams({ cursor: value, limit: String(limit) }),
        validators,
      );
      expect(parsed).toEqual({ valid: true, value: { cursor: value, limit } });
    }));
  });

  it('canonicalizes idempotency inputs while keeping distinct bodies distinct', () => {
    const iJsonValue = fc.jsonValue({ maxDepth: 8 }).map(toIJsonValue);
    fc.assert(fc.property(iJsonValue, fc.dictionary(
      fc.string({ minLength: 1, maxLength: 12 }),
      iJsonValue,
      { maxKeys: 8 },
    ).map((query) => toIJsonValue(query) as Record<string, fc.JsonValue>), (payload, query) => {
      const reversedQuery = Object.fromEntries(Object.entries(query).reverse());
      const base = {
        protocolVersion: '0.1',
        endpointKey: 'nodes',
        resourceIdentity: 'collection-1',
        query,
        body: { payload, marker: 0 },
      };
      const first = createCanonicalRequestDigest({ ...base, method: 'post', mediaType: ' Application/JSON ' });
      const equivalent = createCanonicalRequestDigest({
        ...base,
        query: reversedQuery,
        method: 'POST',
        mediaType: 'application/json',
      });
      const changed = createCanonicalRequestDigest({
        ...base,
        method: 'POST',
        mediaType: 'application/json',
        body: { payload, marker: 1 },
      });
      expect(equivalent).toBe(first);
      expect(changed).not.toBe(first);
    }));
  });

  it('never lets an added deny grant an effective scope', () => {
    fc.assert(fc.property(
      fc.subarray([...scopes]),
      fc.subarray([...scopes]),
      (granted, denied) => {
        const grantedSet = new Set<ScopeName>(granted);
        const deniedSet = new Set<ScopeName>(denied);
        const allow = policy(granted);
        const restrictive = policy(granted, denied);
        const effective = evaluateEffectiveScopes({
          grantedScopes: grantedSet,
          identities: [user],
          policyChain: { serverDefault: allow, collection: allow, ancestors: [], object: restrictive },
        });
        expect([...effective].every((scope) => grantedSet.has(scope) && !deniedSet.has(scope))).toBe(true);
      },
    ));
  });

  it('replays every recorded Sync sequence and accepts only the next sequence', () => {
    fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 32 }), {
      minLength: 1,
      maxLength: 40,
    }), (results) => {
      let state = createSequenceState<string>();
      results.forEach((result, index) => {
        const sequence = index + 1;
        const digest = `digest-${sequence}-${result}`;
        expect(decideSequence(state, sequence, digest)).toEqual({ kind: 'accept' });
        state = recordSequenceResult(state, { sequence, digest, status: 'applied', result });
        expect(decideSequence(state, sequence, digest)).toEqual({ kind: 'replay', result });
        expect(decideSequence(state, sequence, `${digest}-different`)).toEqual({ kind: 'sequence_reuse' });
      });
      expect(decideSequence(state, results.length + 1, 'next')).toEqual({ kind: 'accept' });
      expect(decideSequence(state, results.length + 2, 'gap')).toEqual({
        kind: 'sequence_gap',
        expectedSequence: results.length + 1,
      });
    }), { numRuns: 80 });
  });

  it('round-trips session create/verify/terminate for random session ids', async () => {
    const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/);
    await fc.assert(fc.asyncProperty(id, fc.option(fc.constant('2026-12-01T00:00:00Z'), { nil: undefined }), async (sessionId, expiresAt) => {
      const store = propertySessionStore();
      const input: CreateSyncSessionInput = {
        sessionId,
        principal: { type: 'user', id: 'property-user' },
        credential: { kind: 'token', id: 'token-property' },
        oauthClientId: 'https://client.example/app',
        origin: 'https://client.example',
        sessionScope: 'collection',
        protocolVersion: '0.1',
        collectionId: 'collection-property',
        purpose: null,
        authorizationScopes: ['sync:pull', 'sync:push'],
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      const created = await createSyncSession(store, input);
      expect(created.status).toBe('active');
      expect(created.sessionId).toBe(sessionId);

      const verified = await verifySyncSessionContext(store, {
        sessionId,
        binding: {
          principal: input.principal,
          credential: input.credential,
          oauthClientId: input.oauthClientId,
          origin: input.origin,
          sessionScope: input.sessionScope,
          protocolVersion: input.protocolVersion,
          collectionId: input.collectionId,
          purpose: input.purpose,
        },
        authorization: {
          credentialActive: true,
          authorizationScopes: [...input.authorizationScopes],
        },
        terminatedAt: '2026-07-18T02:00:00Z',
      });
      expect(verified.state).toBe('active');

      const terminated = await terminateSyncSession(store, {
        sessionId,
        reason: 'administrative',
        terminatedAt: '2026-07-18T03:00:00Z',
      });
      expect(terminated?.status).toBe('terminated');
    }), { numRuns: 40 });
  });

  it('denies credential restrictions when the request collection is outside every allowlist', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{3,12}$/), { minLength: 1, maxLength: 4 }),
      fc.stringMatching(/^[a-z]{3,12}$/),
      async (allowedCollections, requested) => {
        fc.pre(!allowedCollections.includes(requested));
        const restriction: CredentialRestriction = {
          collectionAllowlist: allowedCollections,
          allowPublicExposure: true,
        };
        const ports: CredentialRestrictionPorts = {
          nodeSubtree: { isAllowed: async () => true },
          operationBudget: { checkAndConsume: async () => true },
          clock: { now: () => Date.parse('2026-07-18T04:00:00.000Z') },
        };
        const decision = await enforceCredentialRestrictions(ports, {
          credentialId: 'key-property',
          restrictions: [restriction],
          collectionId: requested,
          operationCost: 1,
          publicExposure: false,
        });
        expect(decision.allowed).toBe(false);
      },
    ), { numRuns: 40 });
  });

  it('selects a denying ceiling over allowed ones for random multi-ceiling outcomes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('credential', 'ip', 'instance') as fc.Arbitrary<'credential' | 'ip' | 'instance'>,
      fc.integer({ min: 1, max: 60 }),
      async (deniedDimension, resetSeconds) => {
        const port: AtomicRateLimitPort = {
          charge: async (charge: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> => ({
            ceilings: charge.ceilings.map((ceiling): AtomicRateLimitCeilingResult => ({
              dimension: ceiling.dimension,
              key: ceiling.key,
              allowed: ceiling.dimension !== deniedDimension,
              remaining: ceiling.dimension === deniedDimension ? 0 : ceiling.limit - 1,
              resetSeconds: ceiling.dimension === deniedDimension ? resetSeconds : 5,
            })),
          }),
        };
        const decision = await enforceRateLimit(port, {
          bucket: 'publisher:general-write',
          cost: 1,
          credentialId: 'key-property',
          ipAddress: '203.0.113.50',
          instanceId: 'instance-property',
          ceilings: {
            credential: { policy: 'write:credential', limit: 10, windowSeconds: 60 },
            ip: { policy: 'write:ip', limit: 100, windowSeconds: 60 },
            instance: { policy: 'write:instance', limit: 1_000, windowSeconds: 300 },
          },
        });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed && decision.reason === 'limited') {
          expect(decision.governing.dimension).toBe(deniedDimension);
          expect(decision.retryAfterSeconds).toBe(resetSeconds);
        } else {
          expect(decision.reason).toBe('limited');
        }
      },
    ), { numRuns: 30 });
  });
});

function propertySessionStore(): SyncSessionStore {
  const state = new Map<string, SyncSessionRecord>();
  return {
    async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
      const existing = state.get(session.sessionId);
      if (existing !== undefined) return { state: 'conflict', session: structuredClone(existing) };
      const stored = structuredClone(session);
      state.set(session.sessionId, stored);
      return { state: 'created', session: structuredClone(stored) };
    },
    async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
      const session = state.get(sessionId);
      return session === undefined ? undefined : structuredClone(session);
    },
    async terminate(termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined> {
      const existing = state.get(termination.sessionId);
      if (existing === undefined) return undefined;
      if (existing.status === 'terminated') return structuredClone(existing);
      const terminated: SyncSessionRecord = {
        ...structuredClone(existing),
        status: 'terminated',
        terminationReason: termination.reason,
        terminatedAt: termination.terminatedAt,
      };
      state.set(termination.sessionId, terminated);
      return structuredClone(terminated);
    },
  };
}
