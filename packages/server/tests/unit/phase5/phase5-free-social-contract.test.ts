import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const backendRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/phase5');
const contractPath = resolve(fixtureRoot, 'free-social-contract.v1.json');
const verifierPath = resolve(backendRoot, 'scripts/verify-phase5-free-social-contract.mjs');

interface Phase5ContractFixture {
  identity: {
    followAuthorityKey: string[];
    profileIdentity: { field: string; stability: string; owner: string; encoding: string;
      entropyBytes: number; canonicalLength: number };
    handle: { stability: string; owner: string; authorityUse: string };
    followGrantsCollectionAccess: boolean;
  };
  productApi: {
    baseDocument: string;
    compatibility: string;
    dtoSchemas: Record<string, { required: string[]; properties: Record<string, string> }>;
    operations: Array<{
      method: string;
      path: string;
      operationId: string;
      requestDto: string;
      responseDto: string;
      errors: string[];
    }>;
  };
  events: {
    catalog: Array<{ consumerVersions: number[] }>;
    fixtures: { current: string; previous: string };
  };
  acceptanceArtifactSchema: string;
  requirementMapping: Array<{
    id: string;
    buildTasks: string;
    finalAcceptance: string;
    owner: string;
  }>;
  protocol: { productFeedDeclaresColpFeedProfile: boolean };
}

interface EventFixture {
  fixtureVersion: number;
  events: Array<{
    event_id: string;
    event_type: string;
    event_version: number;
    payload: Record<string, unknown>;
  }>;
}

function runVerifier(contract = contractPath, openapiCandidate?: string) {
  const args = [verifierPath, '--contract', contract];
  if (openapiCandidate) args.push('--openapi-candidate', openapiCandidate);
  return spawnSync(process.execPath, args, {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
}

function readContract(): Phase5ContractFixture {
  return JSON.parse(readFileSync(contractPath, 'utf8')) as Phase5ContractFixture;
}

function mutateContract(mutate: (contract: Phase5ContractFixture) => void): string {
  const contract = readContract();
  mutate(contract);
  const directory = mkdtempSync(join(tmpdir(), 'known-phase5-contract-'));
  const path = join(directory, 'contract.json');
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return path;
}

function writeTemporaryJson(prefix: string, value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = join(directory, 'fixture.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

test('P5-01 exposes one focused executable free-social contract verifier', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['verify:phase5:contracts'],
    'vitest run tests/unit/phase5/phase5-free-social-contract.test.ts',
  );
  const result = runVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /P5-01 free-social contracts verified/u);
});

test('P5-01 freezes stable Profile identity and mutable handle locator ownership', () => {
  const contract = readContract();
  assert.deepEqual(contract.identity.followAuthorityKey, ['actorProfileId', 'targetProfileId']);
  assert.equal(contract.identity.profileIdentity.stability, 'stable');
  assert.deepEqual(contract.identity.profileIdentity, {
    field: 'profileId', stability: 'stable', owner: 'identity', encoding: 'canonical-base64url',
    entropyBytes: 16, canonicalLength: 22,
  });
  assert.equal(contract.identity.handle.stability, 'mutable');
  assert.equal(contract.identity.handle.owner, 'identity');
  assert.equal(contract.identity.handle.authorityUse, 'locator-only');
  assert.equal(contract.identity.followGrantsCollectionAccess, false);
});

test('P5-01 freezes Product paths, DTOs, errors and additive-only OpenAPI intent', () => {
  const contract = readContract();
  const operations = contract.productApi.operations;
  assert.equal(operations.length, 9);
  assert.deepEqual(operations.map(({ method, path }) => `${method} ${path}`), [
    'PUT /api/v1/profiles/{profileId}/follow',
    'DELETE /api/v1/profiles/{profileId}/follow',
    'GET /api/v1/profiles/{profileId}/followers',
    'GET /api/v1/profiles/{profileId}/following',
    'GET /api/v1/me/feed',
    'GET /api/v1/me/notifications',
    'POST /api/v1/me/notifications/read',
    'GET /api/v1/me/notification-preferences',
    'PUT /api/v1/me/notification-preferences',
  ]);
  assert.equal(contract.productApi.compatibility, 'additive-only');
  for (const operation of operations) {
    assert.ok(operation.operationId);
    assert.ok(operation.responseDto);
    assert.ok(Array.isArray(operation.errors));
  }
});

test('P5-01 verifier rejects Product DTO, error, and OpenAPI collision drift', () => {
  const dtoDrift = mutateContract((contract) => {
    contract.productApi.dtoSchemas.FollowRelationDto.required.pop();
  });
  let result = runVerifier(dtoDrift);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*DTO schema catalog drifted/u);

  const errorDrift = mutateContract((contract) => {
    contract.productApi.operations[0].errors.pop();
  });
  result = runVerifier(errorDrift);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*error catalog drifted/u);

  const openapi = parseYaml(readFileSync(resolve(backendRoot, 'openapi/product-v1.yaml'), 'utf8')) as {
    paths: Record<string, unknown>;
  };
  openapi.paths['/api/v1/me/feed'] = { get: { operationId: 'collidingFeed' } };
  const openapiDirectory = mkdtempSync(join(tmpdir(), 'known-phase5-openapi-'));
  const openapiPath = join(openapiDirectory, 'product-v1.yaml');
  writeFileSync(openapiPath, stringifyYaml(openapi), 'utf8');
  result = runVerifier(contractPath, openapiPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*OpenAPI additive compatibility collision/u);
}, 20_000);

test('P5-01 verifier fails when any frozen Product path is deleted from the OpenAPI', () => {
  const openapi = parseYaml(readFileSync(resolve(backendRoot, 'openapi/product-v1.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const frozenOperations = [
    ['PUT', '/api/v1/profiles/{profileId}/follow'],
    ['DELETE', '/api/v1/profiles/{profileId}/follow'],
    ['GET', '/api/v1/profiles/{profileId}/followers'],
    ['GET', '/api/v1/profiles/{profileId}/following'],
    ['GET', '/api/v1/me/feed'],
    ['GET', '/api/v1/me/notifications'],
    ['POST', '/api/v1/me/notifications/read'],
    ['GET', '/api/v1/me/notification-preferences'],
    ['PUT', '/api/v1/me/notification-preferences'],
  ] as const;
  const directory = mkdtempSync(join(tmpdir(), 'known-phase5-openapi-deleted-'));
  for (const [method, path] of frozenOperations) {
    const deleted = JSON.parse(JSON.stringify(openapi)) as typeof openapi;
    if (deleted.paths[path]) delete deleted.paths[path]![method.toLowerCase()];
    const openapiPath = join(directory,
      `deleted-${method.toLowerCase()}-${path.replaceAll('/', '_')}.yaml`);
    writeFileSync(openapiPath, stringifyYaml(deleted), 'utf8');
    const result = runVerifier(contractPath, openapiPath);
    assert.notEqual(result.status, 0, `${method} ${path} deletion must fail closed`);
    assert.match(`${result.stdout}${result.stderr}`,
      /FAIL-CLOSED.*frozen Product path missing/u, `${method} ${path}`);
  }
}, 30_000);

test('P5-01 fixtures pin N/N-1 events and reject unknown versions fail closed', () => {
  const current = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'social-events.n.json'),
    'utf8',
  )) as EventFixture;
  const previous = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'social-events.n-minus-1.json'),
    'utf8',
  )) as EventFixture;
  assert.equal(current.fixtureVersion, 1);
  assert.equal(previous.fixtureVersion, 1);
  assert.deepEqual(current.events.map((event) => `${event.event_type}@${event.event_version}`), [
    'social.follow-created@1',
    'social.follow-removed@1',
    'social.collection-change@2',
    'social.feed-item-published@1',
  ]);
  assert.deepEqual(previous.events.map((event) => `${event.event_type}@${event.event_version}`), [
    'social.collection-change@1',
  ]);
  const collectionChange = current.events.find((event) =>
    event.event_type === 'social.collection-change');
  assert.ok(collectionChange);
  assert.match(collectionChange.event_id, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.match(collectionChange.payload.collectionId as string, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.match(previous.events[0]!.event_id, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.match(previous.events[0]!.payload.collectionId as string,
    /^[A-Za-z0-9_-]{21}[AQgw]$/u);

  const unknownFixture = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'social-events.n.json'),
    'utf8',
  )) as EventFixture;
  unknownFixture.events[0].event_version = 99;
  const unknownPath = writeTemporaryJson('known-phase5-event-unknown-', unknownFixture);
  const unknown = mutateContract((contract) => {
    contract.events.fixtures.current = unknownPath;
  });
  const result = runVerifier(unknown);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*event version/u);
});

test('P5-01 verifier rejects malformed canonical Profile identities and N-1 fixture payloads', () => {
  const current = JSON.parse(readFileSync(resolve(fixtureRoot, 'social-events.n.json'), 'utf8')) as {
    events: Array<{ payload: Record<string, unknown> }>;
  };
  current.events[0].payload.actorProfileId = 'AAAAAAAAAAAAAAAAAAAAAB';
  const invalidCurrent = writeTemporaryJson('known-phase5-event-n-', current);
  const currentDrift = mutateContract((contract) => {
    contract.events.fixtures.current = invalidCurrent;
  });
  let result = runVerifier(currentDrift);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*actorProfileId must be a canonical 16-byte base64url Profile ID/u);

  const previous = JSON.parse(readFileSync(resolve(fixtureRoot, 'social-events.n-minus-1.json'), 'utf8')) as {
    events: Array<{ payload: Record<string, unknown> }>;
  };
  delete previous.events[0].payload.discoverabilityRecheckKey;
  const invalidPrevious = writeTemporaryJson('known-phase5-event-n-minus-1-', previous);
  const previousDrift = mutateContract((contract) => {
    contract.events.fixtures.previous = invalidPrevious;
  });
  result = runVerifier(previousDrift);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*payload.*keys drifted/u);
}, 15_000);

test('P5-01 binds every MVP requirement to construction, final acceptance and one owner', () => {
  const contract = readContract();
  assert.deepEqual(contract.requirementMapping.map((entry) => entry.id), [
    'phase5-contract-gate', 'follow-capability', 'feed-event-contract', 'feed-capability',
    'notification-capability', 'feed-operations', 'notification-operations', 'free-social-closeout',
  ]);
  for (const entry of contract.requirementMapping) {
    assert.match(entry.buildTasks, /^P5-/u);
    assert.match(entry.finalAcceptance, /^P5-/u);
    assert.match(entry.owner, /^(contracts|social|notifications|release)$/u);
  }
});

test('P5-01 source-bound artifact schema includes all P5-26 binding dimensions', () => {
  const schema = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'free-social-acceptance-artifact.schema.json'),
    'utf8',
  )) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);
  for (const field of [
    'backendCommit', 'frontendCommit', 'colpCommit', 'sourceTreeDigest', 'migrationHead',
    'openapiDigest', 'generatedClientDigest', 'eventContractVersion', 'eventContractDigest',
    'runtimeConfigDigest', 'postgresqlVersion', 'browserName', 'browserVersion',
    'followAcceptance', 'feedAcceptance', 'notificationAcceptance', 'feedOperations',
    'notificationOperations', 'monetizationAbsence', 'negativeControls',
  ]) assert.match(serialized, new RegExp(field, 'u'), field);
  assert.match(serialized, /additionalProperties":false/u);
});

test('P5-01 verifier rejects weakened acceptance artifact source binding', () => {
  const schema = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'free-social-acceptance-artifact.schema.json'),
    'utf8',
  )) as {
    properties: { environment: { required: string[] } };
  };
  schema.properties.environment.required = schema.properties.environment.required
    .filter((field) => field !== 'browserVersion');
  const weakenedSchema = writeTemporaryJson('known-phase5-artifact-schema-', schema);
  const contract = mutateContract((value) => {
    value.acceptanceArtifactSchema = weakenedSchema;
  });
  const result = runVerifier(contract);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*environment bindings drifted/u);
});

test('P5-01 verifier fails closed on monetization or COLP Feed Profile drift', () => {
  const monetized = mutateContract((contract) => {
    contract.productApi.operations[0].requestDto = 'SubscriptionRequest';
  });
  let result = runVerifier(monetized);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*Monetization/u);

  const profileClaim = mutateContract((contract) => {
    contract.protocol.productFeedDeclaresColpFeedProfile = true;
  });
  result = runVerifier(profileClaim);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*COLP Feed Profile/u);
});
