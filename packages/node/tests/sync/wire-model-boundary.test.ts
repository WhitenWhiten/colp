import { describe, expect, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as syncApi from '../../src/sync/index.js';

const evidence = '[evidence:sync.wire-model-boundary]';
const validators = createValidatorRegistry();
const timestamp = '2026-07-18T08:00:00Z';
const crdtFields = [
  'vectorClock',
  'vector_clock',
  'lamport',
  'actorId',
  'actor_id',
  'causalContext',
  'causal_context',
  'crdtState',
  'dot',
  'context',
] as const;

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: 'operation-1',
    replicaId: 'replica-1',
    sequence: 7,
    collectionId: 'collection-1',
    type: 'delete_node',
    targetId: 'node-1',
    baseRevision: 'revision-6',
    occurredAt: timestamp,
    dependencies: ['operation-0'],
    payload: { reason: 'duplicate' },
    source: { adapterProfile: 'browser-bookmarks-v1', nativeEvent: 'removed' },
    ...overrides,
  };
}

function operationResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: 'operation-1',
    sequence: 7,
    status: 'applied',
    targetId: 'node-1',
    revision: 'revision-7',
    cursor: 'cursor-7',
    warnings: [],
    ...overrides,
  };
}

function conflict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'conflict-1',
    collectionId: 'collection-1',
    targetId: 'node-1',
    type: 'field_value',
    field: 'title',
    base: 'Original',
    server: 'Server edit',
    incoming: 'Replica edit',
    incomingOpId: 'operation-1',
    createdAt: timestamp,
    status: 'open',
    allowedResolutions: ['server', 'incoming', 'custom', 'both'],
    revision: 'conflict-revision-1',
    ...overrides,
  };
}

function tombstone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'node',
    targetId: 'node-1',
    collectionId: 'collection-1',
    scope: 'single',
    deletedAt: timestamp,
    deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1',
    deleteCursor: 'cursor-delete-1',
    affectedCount: 1,
    purgeAfter: '2026-08-18T08:00:00Z',
    ...overrides,
  };
}

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

function expectAdditionalPropertyRejection(
  definition: Parameters<typeof validators.validate>[0],
  canonical: Record<string, unknown>,
  injected: Record<string, unknown>,
  field: string,
  instancePath: string,
): void {
  expect(validators.validate(definition, canonical)).toEqual({ valid: true, errors: [] });
  const result = validators.validate(definition, injected);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({
      instancePath,
      keyword: 'additionalProperties',
      params: { additionalProperty: field },
    }),
  ]));
}

function expectOpaqueScalarRejection(
  definition: Parameters<typeof validators.validate>[0],
  canonical: Record<string, unknown>,
  injected: Record<string, unknown>,
  field: string,
): void {
  expect(validators.validate(definition, canonical)).toEqual({ valid: true, errors: [] });
  const result = validators.validate(definition, injected);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ instancePath: `/${field}`, keyword: 'type' }),
  ]));
}

describe(`SYNC-0010 canonical Wire model boundary ${evidence}`, () => {
  it(`accepts the canonical Operation log envelope ${evidence}`, () => {
    expect(validators.validate('operation', operation())).toEqual({ valid: true, errors: [] });
  });

  it.each(crdtFields)(`rejects CRDT Operation envelope member %s ${evidence}`, (field) => {
    expectAdditionalPropertyRejection(
      'operation',
      operation(),
      operation({ [field]: { replica: 7 } }),
      field,
      '',
    );
  });

  it.each(crdtFields)(`rejects CRDT metadata inside the typed Operation payload: %s ${evidence}`, (field) => {
    expectAdditionalPropertyRejection(
      'operation',
      operation(),
      operation({ payload: { reason: 'duplicate', [field]: { replica: 7 } } }),
      field,
      '/payload',
    );
  });

  it(`rejects nested causal metadata in the canonical Operation source ${evidence}`, () => {
    for (const field of crdtFields) {
      expectAdditionalPropertyRejection(
        'operation',
        operation(),
        operation({ source: { adapterProfile: 'browser-bookmarks-v1', [field]: 'hidden-state' } }),
        field,
        '/source',
      );
    }
  });

  it(`accepts canonical applied Operation Result revision and cursor fields ${evidence}`, () => {
    expect(validators.validate('operationResult', operationResult()))
      .toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['Operation', 'baseRevision', { replica1: 4, replica2: 6 }],
    ['Operation', 'baseRevision', ['actor-1', 7]],
    ['Operation Result', 'revision', { counter: 7, actorId: 'actor-1' }],
    ['Conflict', 'revision', ['dot-1', 'dot-2']],
  ] as const)(
    `keeps canonical %s %s as an opaque scalar rather than CRDT value %# ${evidence}`,
    (surface, field, value) => {
      if (surface === 'Operation') {
        expectOpaqueScalarRejection('operation', operation(), operation({ [field]: value }), field);
      } else if (surface === 'Operation Result') {
        expectOpaqueScalarRejection(
          'operationResult', operationResult(), operationResult({ [field]: value }), field,
        );
      } else {
        expectOpaqueScalarRejection('conflict', conflict(), conflict({ [field]: value }), field);
      }
    },
  );

  it(`rejects convergence metadata beside canonical Operation Result status and revision ${evidence}`, () => {
    for (const field of crdtFields) {
      expectAdditionalPropertyRejection(
        'operationResult', operationResult(), operationResult({ [field]: 7 }), field, '',
      );
    }
  });

  it(`accepts an explicit canonical Conflict with revision, status, and resolutions ${evidence}`, () => {
    expect(validators.validate('conflict', conflict())).toEqual({ valid: true, errors: [] });
  });

  it(`requires explicit Conflict revision, status, and allowedResolutions fields ${evidence}`, () => {
    for (const field of ['revision', 'status', 'allowedResolutions']) {
      expect(validators.validate('conflict', without(conflict(), field)).valid).toBe(false);
    }
  });

  it(`does not permit hidden convergence metadata to replace or accompany Conflict ${evidence}`, () => {
    for (const field of crdtFields) {
      const hiddenReplacement = without(conflict({ [field]: { actor: 3 } }), 'revision');
      expectAdditionalPropertyRejection(
        'conflict', conflict(), hiddenReplacement, field, '',
      );
      expectAdditionalPropertyRejection(
        'conflict', conflict(), conflict({ [field]: { actor: 3 } }), field, '',
      );
    }
  });

  it(`keeps Conflict resolution explicit and rejects causal resolution state ${evidence}`, () => {
    const request = { resolution: 'custom', value: 'Merged title', baseConflictRevision: 'conflict-revision-1' };
    expect(validators.validate('conflictResolutionRequest', request))
      .toEqual({ valid: true, errors: [] });
    for (const field of crdtFields) {
      expectAdditionalPropertyRejection(
        'conflictResolutionRequest',
        request,
        { ...request, [field]: { actor1: 3 } },
        field,
        '',
      );
    }
  });

  it(`accepts canonical Sync Tombstone and requires its deleteCursor ${evidence}`, () => {
    expect(validators.validate('syncTombstone', tombstone()))
      .toEqual({ valid: true, errors: [] });
    expect(validators.validate('syncTombstone', without(tombstone(), 'deleteCursor')).valid)
      .toBe(false);
  });

  it(`rejects CRDT deletion state on Sync Tombstone ${evidence}`, () => {
    for (const field of [...crdtFields, 'deleteDot']) {
      expectAdditionalPropertyRejection(
        'syncTombstone', tombstone(), tombstone({ [field]: 'deletion-state' }), field, '',
      );
    }
  });

  it(`rejects CRDT metadata nested in canonical Sync Pull Operation and Conflict events ${evidence}`, () => {
    const canonicalPull = {
      events: [
        { cursor: 'cursor-7', kind: 'operation', operation: operation() },
        { cursor: 'cursor-8', kind: 'conflict', conflict: conflict() },
      ],
      nextCursor: 'cursor-8',
      hasMore: false,
      collectionRevision: 'revision-8',
      recommendedPullAfterSeconds: 0,
    };
    expect(validators.validate('syncPull', canonicalPull)).toEqual({ valid: true, errors: [] });
    const operationPull = {
      ...canonicalPull,
      events: [{ cursor: 'cursor-7', kind: 'operation', operation: operation({ dot: 'a.7' }) }],
    };
    expectAdditionalPropertyRejection(
      'syncPull', canonicalPull, operationPull, 'dot', '/events/0/operation',
    );
    const conflictPull = {
      ...canonicalPull,
      events: [{ cursor: 'cursor-8', kind: 'conflict', conflict: conflict({ context: ['a.7'] }) }],
    };
    expectAdditionalPropertyRejection(
      'syncPull', canonicalPull, conflictPull, 'context', '/events/0/conflict',
    );
  });

  it(`registers canonical Wire definitions without a CRDT model definition ${evidence}`, () => {
    expect(validators.definitionNames).toEqual(expect.arrayContaining([
      'operation', 'operationResult', 'conflict', 'conflictResolutionRequest', 'syncTombstone',
    ]));
    expect(validators.definitionNames.filter((name) => /crdt|vector.?clock|lamport|causal|dot/i.test(name)))
      .toEqual([]);
  });

  it(`does not expose CRDT wire-model names from root or sync public APIs ${evidence}`, () => {
    for (const api of [publicSyncApi, syncApi]) {
      const names = Object.getOwnPropertyNames(api);
      expect(names.filter((name) => /crdt|vector.?clock|lamport|causal|dot/i.test(name)))
        .toEqual([]);
    }
  });

  it(`resolves public export descriptors without a CRDT API escape hatch ${evidence}`, () => {
    for (const api of [publicSyncApi, syncApi]) {
      const descriptors = Object.getOwnPropertyDescriptors(api);
      for (const [name, descriptor] of Object.entries(descriptors)) {
        expect(descriptor.set, `unexpected public accessor ${name}`).toBeUndefined();
        const value = descriptor.get === undefined ? descriptor.value : descriptor.get.call(api);
        expect(name).not.toMatch(/crdt|vector.?clock|lamport|causal|dot/i);
        if (typeof value === 'function') {
          const callable = value as { readonly name: string };
          expect(`${name} ${callable.name}`).not.toMatch(/crdt|vector.?clock|lamport|causal|dot/i);
          expect(Object.getOwnPropertyNames(callable).filter((key) => /crdt/i.test(key)))
            .toEqual([]);
        }
      }
      const symbols = Object.getOwnPropertySymbols(api);
      expect(symbols.filter((symbol) => symbol !== Symbol.toStringTag)).toEqual([]);
      if (symbols.includes(Symbol.toStringTag)) {
        expect((api as { readonly [Symbol.toStringTag]?: string })[Symbol.toStringTag])
          .toBe('Module');
      }
    }
  });
});
