import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/phase5');
const verifierPath = resolve(backendRoot, 'scripts/verify-phase5-social-events.mjs');

interface ConsumerFixture {
  format: string;
  acceptedEventVersions: number[];
  rejectedEventVersions: number[];
  cases: Array<{
    id: string;
    secretMarker: string;
    producerVisibility: 'private' | 'protected' | 'unlisted' | 'public' | 'deleted';
    currentDiscoverability: 'not_discoverable' | 'public' | 'deleted';
    expectedDisposition: string;
    event: Record<string, unknown>;
  }>;
}

interface MaliciousFixture {
  format: string;
  controls: Array<{
    id: string;
    secretMarker: string;
    expectedFailure: string;
    markerPath: string | null;
    markerMirrorPaths: string[];
    mutation: Record<string, unknown>;
  }>;
}

function runVerifier(...args: string[]) {
  return spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T;
}

test('P5-08 exposes one focused executable privacy-safe social event verifier', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['verify:phase5:social-events'],
    'vitest run tests/unit/phase5/phase5-social-event-contract.test.ts',
  );
  const result = runVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /P5-08 privacy-safe social events verified/u);
});

test('P5-08 freezes current and N-1 consumers without exposing visibility classes', () => {
  const current = readJson<ConsumerFixture>('social-collection-change.consumer.n.json');
  const previous = readJson<ConsumerFixture>('social-collection-change.consumer.n-minus-1.json');
  assert.equal(current.format, 'known.phase5.social-collection-change.consumer.n.v1');
  assert.equal(previous.format, 'known.phase5.social-collection-change.consumer.n-minus-1.v1');
  assert.deepEqual(current.acceptedEventVersions, [1, 2]);
  assert.deepEqual(current.rejectedEventVersions, [3]);
  assert.deepEqual(previous.acceptedEventVersions, [1]);
  assert.deepEqual(previous.rejectedEventVersions, [2]);
  assert.deepEqual(current.cases.map(({ producerVisibility, expectedDisposition }) =>
    `${producerVisibility}:${expectedDisposition}`), [
    'public:recheck_required',
    'public:recheck_then_upsert',
    'public:remove_after_recheck',
    'unlisted:remove',
    'protected:remove',
    'private:remove',
    'deleted:remove',
  ]);
  assert.deepEqual(previous.cases.map(({ expectedDisposition }) => expectedDisposition), [
    'recheck_required',
  ]);

  for (const fixture of [current, previous]) {
    for (const scenario of fixture.cases) {
      const serializedEvent = JSON.stringify(scenario.event);
      assert.ok(!serializedEvent.includes(scenario.secretMarker), scenario.id);
      for (const forbidden of ['private', 'protected', 'unlisted']) {
        assert.ok(!serializedEvent.includes(`\"producerDiscoverability\":\"${forbidden}\"`), scenario.id);
      }
      for (const classification of ['private', 'protected', 'unlisted', 'deleted']) {
        assert.ok(!serializedEvent.includes(`\"${classification}\"`), scenario.id);
      }
      assert.ok(!serializedEvent.includes('changeKind'), scenario.id);
      const event = scenario.event as {
        event_id: string;
        payload: { collectionId: string };
      };
      assert.match(event.event_id, /^[A-Za-z0-9_-]{21}[AQgw]$/u, scenario.id);
      assert.match(event.payload.collectionId, /^[A-Za-z0-9_-]{21}[AQgw]$/u, scenario.id);
    }
  }
});

test('P5-08 rejects unknown type/version fail closed while preserving replay', () => {
  const malicious = readJson<MaliciousFixture>('social-collection-change.malicious.json');
  for (const id of ['unknown-event-type', 'unknown-event-version']) {
    const control = malicious.controls.find((candidate) => candidate.id === id);
    assert.ok(control, id);
    const result = runVerifier('--candidate', resolve(fixtureRoot,
      `social-collection-change.candidate.${id}.json`));
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`,
      /FAIL-CLOSED \[(?:unsupported_event_type|unsupported_event_version)\] replayable=true complete=false/u);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(control.secretMarker));
    const candidate = readFileSync(resolve(fixtureRoot,
      `social-collection-change.candidate.${id}.json`), 'utf8');
    const payload = JSON.stringify((JSON.parse(candidate) as { payload: unknown }).payload);
    assert.ok(payload.includes(control.secretMarker), `${id} marker must enter the rejected payload`);
  }
});

test('P5-08 malicious fixtures cover closed payload, ordering, privacy and size controls', () => {
  const fixture = readJson<MaliciousFixture>('social-collection-change.malicious.json');
  assert.deepEqual(fixture.controls.map(({ id }) => id), [
    'unknown-event-type', 'unknown-event-version', 'invalid-event-id',
    'invalid-collection-id', 'utf8-payload-at-limit',
    'utf8-payload-over-limit', 'missing-field',
    'extra-field', 'wrong-aggregate-scope', 'wrong-aggregate-revision', 'invalid-order',
    'invalid-recheck-key', 'private-body', 'private-content', 'protected-title',
    'protected-summary', 'unlisted-handle', 'public-email', 'membership-facts',
    'policy-facts', 'cursor-material', 'token-material', 'secret-material',
    'credential-material', 'cookie-material',
  ]);
  assert.equal(new Set(fixture.controls.map(({ secretMarker }) => secretMarker)).size,
    fixture.controls.length);
  const byteBoundaries = fixture.controls
    .filter(({ id }) => id.startsWith('utf8-payload-'))
    .map(({ mutation }) => [mutation.targetPayloadBytes, mutation.fill]);
  assert.deepEqual(byteBoundaries, [[2048, '界'], [2049, '界']]);
  assert.ok(Buffer.byteLength('界', 'utf8') > '界'.length);

  const result = runVerifier('--controls', resolve(fixtureRoot,
    'social-collection-change.malicious.json'));
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  for (const control of fixture.controls) {
    assert.match(result.stdout, new RegExp(`${control.id}=failed_closed`, 'u'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(control.secretMarker), control.id);
  }
});

test('P5-08 verifier binds aggregate scope, revision, order and recheck key', () => {
  const result = runVerifier('--print-contract');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    eventType: string;
    producerVersion: number;
    consumerVersions: number[];
    productEventIsColpFeedEvent: boolean;
    aggregate: Record<string, unknown>;
    identities: Record<string, unknown>;
    ordering: Record<string, unknown>;
    discoverability: Record<string, unknown>;
    rollout: { unknownPolicy: string; expandOrder: string[] };
    retentionRebuild: {
      sourceEventTtlDays: number;
      feedItemTtlDays: number;
      unresolvedRowsPurgeable: boolean;
      rebuildWindow: string;
      authoritySources: string[];
      procedure: string[];
    };
  };
  assert.equal(output.eventType, 'social.collection-change');
  assert.equal(output.producerVersion, 2);
  assert.deepEqual(output.consumerVersions, [1, 2]);
  assert.equal(output.productEventIsColpFeedEvent, false);
  assert.deepEqual(output.aggregate, {
    aggregateType: 'collection',
    aggregateId: 'payload.collectionId',
    aggregateScope: 'payload.collectionId',
    aggregateRevision: 'payload.publicationRevision',
  });
  assert.deepEqual(output.identities, {
    eventId: 'canonical-16-byte-base64url',
    collectionId: 'canonical-16-byte-base64url',
  });
  assert.deepEqual(output.ordering, {
    watermarkScope: 'aggregate_identity.aggregate_scope',
    monotonicFact: 'commit_ordinal',
    comparison: 'decimal-integer-greater-than',
    opaqueRevisionComparable: false,
  });
  assert.deepEqual(output.discoverability, {
    recheckKeyFormat: 'publication.collection:<collectionId>',
    producerFacts: ['public_candidate', 'remove'],
    consumerMustRecheck: true,
  });
  assert.deepEqual(output.rollout, {
    unknownPolicy: 'fail-closed-replayable-not-completed',
    expandOrder: ['deploy-consumer-1-and-2', 'enable-producer-2',
      'drain-retained-version-1', 'remove-consumer-1-later'],
  });
  assert.equal(output.retentionRebuild.sourceEventTtlDays, 90);
  assert.equal(output.retentionRebuild.feedItemTtlDays, 90);
  assert.equal(output.retentionRebuild.unresolvedRowsPurgeable, false);
  assert.equal(output.retentionRebuild.rebuildWindow, 'retained-source-window-only');
  assert.deepEqual(output.retentionRebuild.authoritySources, [
    'retained-social.collection-change-events', 'authoritative-follow-graph',
    'current-publication-discoverability',
  ]);
  assert.deepEqual(output.retentionRebuild.procedure, [
    'capture-per-scope-high-watermark', 'replay-ascending-commit-ordinal',
    'dual-apply-live-events', 'recheck-current-discoverability-before-write',
    'cas-watermark-with-projection', 'cut-over-after-captured-watermarks',
  ]);
});
