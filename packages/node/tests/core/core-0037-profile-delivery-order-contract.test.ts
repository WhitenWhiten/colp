import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as deliveryBoundary from '../../src/delivery/index.js';
import type { DeliveryCompletionClaim } from '../../src/delivery/index.js';
import * as packageBoundary from '../../src/index.js';
import {
  assertProfileClaims,
  bundledConformanceEvidence,
  evaluateProfileClaims,
  type DeploymentRuntimeProbes,
  type ProtocolProfile,
} from '../../src/conformance/index.js';
import { endpointContracts, profileDependencies } from '../../src/semantic/index.js';

const evidence = '[evidence:core.profile-delivery-order]';

const expectedStages = [
  { ordinal: 1, id: 'core-publication', components: ['core', 'publication'] },
  { ordinal: 2, id: 'publisher', components: ['publisher'] },
  { ordinal: 3, id: 'feed-release', components: ['feed'], initialMode: 'release' },
  { ordinal: 4, id: 'sync', components: ['sync'] },
  { ordinal: 5, id: 'mcp-read-write', components: ['mcp-read', 'mcp-write'] },
] as const;

const fullDelivery = [
  { profile: 'core' },
  { profile: 'publication' },
  { profile: 'publisher' },
  { profile: 'feed', mode: 'release' },
  { profile: 'sync' },
  { profile: 'mcp-read' },
  { profile: 'mcp-write' },
] as const;

const validProgressCases = [
  ['nothing delivered', [], 0, 0, 'pending'],
  ['partial core plus publication group', fullDelivery.slice(0, 1), 0, 0, 'in-progress'],
  ['core plus publication delivered', fullDelivery.slice(0, 2), 1, 1, 'pending'],
  ['publisher delivered second', fullDelivery.slice(0, 3), 2, 2, 'pending'],
  ['release feed delivered third', fullDelivery.slice(0, 4), 3, 3, 'pending'],
  ['sync delivered fourth', fullDelivery.slice(0, 5), 4, 4, 'pending'],
  ['partial final MCP group from mcp-read', fullDelivery.slice(0, 6), 4, 4, 'in-progress'],
  ['partial final MCP group from mcp-write', [...fullDelivery.slice(0, 5), fullDelivery[6]], 4, 4, 'in-progress'],
  ['group members may complete in either order', [{ profile: 'publication' }, { profile: 'core' }], 1, 1, 'pending'],
  ['all five stages delivered', fullDelivery, 5, null, null],
] as const;

const skippedStageCases = [
  ['publisher before stage one', [{ profile: 'publisher' }]],
  ['publication partial then publisher', [{ profile: 'publication' }, { profile: 'publisher' }]],
  ['feed before publisher', [...fullDelivery.slice(0, 2), fullDelivery[3]]],
  ['sync before feed', [...fullDelivery.slice(0, 3), fullDelivery[4]]],
  ['MCP read before sync', [...fullDelivery.slice(0, 4), fullDelivery[5]]],
  ['MCP write before sync', [...fullDelivery.slice(0, 4), fullDelivery[6]]],
] as const;

const outOfOrderCases = [
  ['publisher after feed', [fullDelivery[0], fullDelivery[1], fullDelivery[3], fullDelivery[2]]],
  ['feed after sync', [...fullDelivery.slice(0, 3), fullDelivery[4], fullDelivery[3]]],
  ['sync after MCP read', [...fullDelivery.slice(0, 4), fullDelivery[5], fullDelivery[4]]],
] as const;

const invalidClaimCases = [
  ['unknown profile', [{ profile: 'future' }]],
  ['legacy reader profile', [{ profile: 'reader' }]],
  ['legacy writer profile', [{ profile: 'writer' }]],
  ['duplicate core', [{ profile: 'core' }, { profile: 'core' }]],
  ['contradictory feed modes', [...fullDelivery.slice(0, 3), { profile: 'feed', mode: 'release' }, { profile: 'feed', mode: 'live' }]],
  ['feed without a mode', [...fullDelivery.slice(0, 3), { profile: 'feed' }]],
  ['feed with a non-release mode', [...fullDelivery.slice(0, 3), { profile: 'feed', mode: 'change' }]],
  ['mode on core', [{ profile: 'core', mode: 'release' }]],
  ['early types mistaken for delivery', [{ profile: 'types' }]],
  ['early Schema mistaken for delivery', [{ profile: 'schema' }]],
  ['missing profile', [{}]],
  ['unknown record field', [{ profile: 'core', delivered: true }]],
  ['primitive record', ['core']],
  ['null record', [null]],
  ['array record', [['core']]],
  ['non-string profile', [{ profile: 1 }]],
] as const;

const nonArrayCases = [
  ['string', 'core'],
  ['Set', new Set(['core'])],
  ['array-like object', { 0: { profile: 'core' }, length: 1 }],
  ['null', null],
] as const;

const completeProbes: DeploymentRuntimeProbes = {
  registeredEndpoints: new Set(Object.keys(endpointContracts) as (keyof typeof endpointContracts)[]),
  availablePorts: new Set([
    'approval',
    'audit',
    'client',
    'feed',
    'idempotency',
    'mcp',
    'outbox',
    'publisher',
    'schema',
    'semantic',
    'server',
    'sync',
    'transactions',
  ]),
};

describe(`CORE-0037 profile delivery order contract ${evidence}`, () => {
  it('keeps the expanded case matrix explicit', () => {
    expect(expectedStages).toHaveLength(5);
    expect(expectedStages.flatMap(({ components }) => components)).toHaveLength(7);
    expect(validProgressCases).toHaveLength(10);
    expect(skippedStageCases).toHaveLength(6);
    expect(outOfOrderCases).toHaveLength(3);
    expect(invalidClaimCases).toHaveLength(16);
    expect(nonArrayCases).toHaveLength(4);
  });

  it('publishes exactly the five ordered stages and both required grouped boundaries', () => {
    expect(deliveryBoundary.deliveryStages).toEqual(expectedStages);
    expect(deliveryBoundary.deliveryStages.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(deliveryBoundary.deliveryStages[0]?.components).toEqual(['core', 'publication']);
    expect(deliveryBoundary.deliveryStages[4]?.components).toEqual(['mcp-read', 'mcp-write']);
    expect(deliveryBoundary.deliveryStages[2]).toMatchObject({
      id: 'feed-release',
      components: ['feed'],
      initialMode: 'release',
    });
  });

  it('makes the canonical stage registry deeply immutable', () => {
    expect(Object.isFrozen(deliveryBoundary.deliveryStages)).toBe(true);
    for (const stage of deliveryBoundary.deliveryStages) {
      expect(Object.isFrozen(stage)).toBe(true);
      expect(Object.isFrozen(stage.components)).toBe(true);
    }
  });

  it.each(validProgressCases)(
    'reports valid incremental state: %s',
    (_label, claims, deliveredStageCount, currentStageIndex, currentState) => {
      const result = deliveryBoundary.planDelivery(claims);
      expect(result.deliveredStageCount).toBe(deliveredStageCount);
      expect(result.currentStage).toBe(currentStageIndex === null ? null : result.stages[currentStageIndex]);
      expect(result.currentStage?.state ?? null).toBe(currentState);
      expect(result.complete).toBe(deliveredStageCount === 5);
      expect(result.completedComponents).toEqual(
        fullDelivery.map(({ profile }) => profile).filter((profile) => claims.some((claim) => claim.profile === profile)),
      );
      expect(deliveryBoundary.assertDeliveryOrder(claims)).toEqual(result);
    },
  );

  it('does not mark either grouped stage delivered while only half is complete', () => {
    const first = deliveryBoundary.planDelivery([{ profile: 'core' }]);
    const last = deliveryBoundary.planDelivery(fullDelivery.slice(0, 6));
    expect(first.stages[0]).toMatchObject({
      state: 'in-progress',
      completedComponents: ['core'],
      missingComponents: ['publication'],
    });
    expect(last.stages[4]).toMatchObject({
      state: 'in-progress',
      completedComponents: ['mcp-read'],
      missingComponents: ['mcp-write'],
    });
  });

  it.each(skippedStageCases)('rejects a skipped stage: %s', (_label, claims) => {
    expect(() => deliveryBoundary.planDelivery(claims as unknown as readonly DeliveryCompletionClaim[])).toThrow(/cannot start before/u);
  });

  it.each(outOfOrderCases)('rejects chronological completion claims that are out of order: %s', (_label, claims) => {
    expect(() => deliveryBoundary.assertDeliveryOrder(claims as unknown as readonly DeliveryCompletionClaim[])).toThrow(/order|before/u);
  });

  it.each(invalidClaimCases)('rejects invalid or contradictory input: %s', (_label, claims) => {
    expect(() => deliveryBoundary.planDelivery(claims as unknown as readonly DeliveryCompletionClaim[])).toThrow(TypeError);
  });

  it.each(nonArrayCases)('rejects a non-array completion container: %s', (_label, claims) => {
    expect(() => deliveryBoundary.planDelivery(claims as unknown as readonly DeliveryCompletionClaim[])).toThrow(/must be an array/u);
  });

  it('rejects sparse, decorated, symbol-bearing, and accessor-backed containers and records', () => {
    const sparse = Array(1) as unknown as typeof fullDelivery;
    const decorated = Object.assign([{ profile: 'core' }], { metadata: true });
    const symbolArray = [{ profile: 'core' }];
    Object.defineProperty(symbolArray, Symbol('extra'), { value: true });
    const accessorArray = [{ profile: 'core' }];
    Object.defineProperty(accessorArray, '0', { get: () => ({ profile: 'core' }) });
    const accessorProfile = Object.defineProperty({}, 'profile', { get: () => 'core' });
    const accessorMode = Object.defineProperties({}, {
      profile: { value: 'feed', enumerable: true },
      mode: { get: () => 'release', enumerable: true },
    });
    const symbolRecord = { profile: 'core' };
    Object.defineProperty(symbolRecord, Symbol('extra'), { value: true });

    for (const candidate of [sparse, decorated, symbolArray, accessorArray, [accessorProfile], [accessorMode], [symbolRecord]]) {
      expect(() => deliveryBoundary.planDelivery(candidate as unknown as readonly DeliveryCompletionClaim[])).toThrow(TypeError);
    }
  });

  it('rejects non-plain completion records', () => {
    class Claim { profile = 'core'; }
    expect(() => deliveryBoundary.planDelivery([new Claim()] as unknown as readonly DeliveryCompletionClaim[])).toThrow(/plain object/u);
  });

  it('returns deterministic, detached, deeply immutable status snapshots', () => {
    const callerClaims = fullDelivery.slice(0, 2).map((claim) => ({ ...claim }));
    const first = deliveryBoundary.planDelivery(callerClaims);
    const second = deliveryBoundary.planDelivery(fullDelivery.slice(0, 2));

    callerClaims[0]!.profile = 'publisher' as 'core';
    callerClaims.push({ profile: 'publisher' } as unknown as { profile: 'core' });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.completedComponents).toEqual(['core', 'publication']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.stages)).toBe(true);
    expect(Object.isFrozen(first.completedComponents)).toBe(true);
    for (const stage of first.stages) {
      expect(Object.isFrozen(stage)).toBe(true);
      expect(Object.isFrozen(stage.components)).toBe(true);
      expect(Object.isFrozen(stage.completedComponents)).toBe(true);
      expect(Object.isFrozen(stage.missingComponents)).toBe(true);
    }
  });

  it('rejects Proxy, subclassed, and hidden-property exotic inputs', () => {
    class Claims extends Array<DeliveryCompletionClaim> {}
    const hiddenItem = [{ profile: 'core' }];
    Object.defineProperty(hiddenItem, '0', { value: { profile: 'core' }, enumerable: false });
    const hiddenProfile = Object.defineProperty({}, 'profile', { value: 'core', enumerable: false });
    const hiddenMode = Object.defineProperties({}, {
      profile: { value: 'feed', enumerable: true },
      mode: { value: 'release', enumerable: false },
    });

    for (const candidate of [
      new Proxy([{ profile: 'core' }], {}),
      new Claims({ profile: 'core' }),
      hiddenItem,
      [new Proxy({ profile: 'core' }, {})],
      [hiddenProfile],
      [...fullDelivery.slice(0, 3), hiddenMode],
    ]) {
      expect(() => deliveryBoundary.planDelivery(candidate as unknown as readonly DeliveryCompletionClaim[])).toThrow(TypeError);
    }
  });

  it('keeps delivery progress separate from Profile dependency closure', () => {
    expect(profileDependencies).toEqual({
      core: [],
      publication: ['core'],
      feed: ['publication'],
      publisher: ['publication'],
      sync: ['core'],
      'mcp-read': ['core'],
      'mcp-write': ['mcp-read', 'publisher'],
    });
    expect(profileDependencies.sync).not.toContain('feed');
    expect(profileDependencies['mcp-read']).not.toContain('sync');
    expect(deliveryBoundary.deliveryStages.find(({ id }) => id === 'sync')?.ordinal).toBe(4);
    expect(deliveryBoundary.deliveryStages.find(({ id }) => id === 'mcp-read-write')?.ordinal).toBe(5);
  });

  it('does not turn delivery, early type, or Schema availability into runtime Profile claims', () => {
    const completed = deliveryBoundary.planDelivery(fullDelivery);
    const attemptedClaims = completed.completedComponents as readonly ProtocolProfile[];
    expect(completed.complete).toBe(true);
    expect(packageBoundary.supportedProfiles).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
    expect(bundledConformanceEvidence.passedRequirementIds).toBeInstanceOf(Array);
    expect(evaluateProfileClaims({ registeredEndpoints: new Set(), availablePorts: new Set() })).toEqual([]);
    expect(() => assertProfileClaims(['core'], { registeredEndpoints: new Set(), availablePorts: new Set() })).toThrow(/lack complete/u);
    expect(() => assertProfileClaims(attemptedClaims, completeProbes)).toThrow(/lack complete/u);
    expect(() => evaluateProfileClaims({
      ...completeProbes,
      passingTests: new Set([evidence]),
      passedRequirementIds: new Set(['CORE-0037']),
    } as unknown as DeploymentRuntimeProbes)).toThrow(/deploymentEvidence/u);
    expect(() => (bundledConformanceEvidence.passedRequirementIds as string[]).push('CORE-0037')).toThrow(TypeError);
    expect(Object.isFrozen(bundledConformanceEvidence)).toBe(true);
    expect(Object.isFrozen(bundledConformanceEvidence.passedRequirementIds)).toBe(true);
  });

  it('keeps delivery APIs on the dedicated public boundary', () => {
    expect(deliveryBoundary.deliveryStages).toEqual(expectedStages);
    expect(deliveryBoundary.planDelivery).toBeTypeOf('function');
    expect(deliveryBoundary.assertDeliveryOrder).toBeTypeOf('function');
    expectTypeOf(deliveryBoundary.planDelivery).toBeFunction();
    expect(packageBoundary).not.toHaveProperty('deliveryStages');
    expect(packageBoundary).not.toHaveProperty('planDelivery');
    expect(packageBoundary).not.toHaveProperty('assertDeliveryOrder');
  });

  it('publishes delivery, Publisher, early types, Schema, and the /mcp Read package candidate without unfinished Profile subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports)).toContain('.');
    expect(Object.keys(packageJson.exports)).toContain('./delivery');
    expect(Object.keys(packageJson.exports)).toContain('./publisher');
    expect(Object.keys(packageJson.exports)).toContain('./feed');
    expect(Object.keys(packageJson.exports)).toContain('./types');
    expect(Object.keys(packageJson.exports)).toContain('./schema');
    // `/mcp` is the Modern Read package candidate entry formed by COLP-MCP-12 (see
    // docs/development/mcp-2026-07-28/colp-sdk-development-plan.md §2/§5); it is a package
    // surface, not a Profile claim. `./sync` is a first-class subpath (H-16).
    // `mcp-read` / `mcp-write` Profile subpaths stay unexported.
    expect(Object.keys(packageJson.exports)).toContain('./mcp');
    expect(Object.keys(packageJson.exports)).toContain('./sync');
    for (const unfinishedSubpath of [
      './mcp-read', './mcp-write',
    ]) {
      expect(Object.hasOwn(packageJson.exports, unfinishedSubpath)).toBe(false);
    }
  });
});
