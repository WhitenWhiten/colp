import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { test } from 'vitest';
import {
  CAPABILITY_PROOF_ALLOWED_CLASSES,
  EVIDENCE_CLASSES,
  GATE_CATALOGS,
  PRODUCTION_SURFACES,
  SUPPORTING_SURFACES,
  attachGateEvidenceClass,
  buildCapabilityEvidence,
  buildCapabilityProof,
  buildNotificationCapabilityProof,
  resolveGateClassification,
} from '../../../scripts/phase5-evidence-class.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function makeGate(
  family: keyof typeof GATE_CATALOGS,
  id: string,
  outputDigest = 'a'.repeat(64),
): Record<string, unknown> {
  return attachGateEvidenceClass(family, {
    id,
    status: 'passed',
    command: `gate:${id}`,
    durationMs: 1,
    resultSummary: `${id} passed`,
    outputDigest,
  });
}

test('R5-09 exposes supporting evidence-class focused gate without postgres wrapper', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:evidence-class'],
    'vitest run tests/unit/phase5/phase5-evidence-class.test.ts',
  );
  assert.equal(/with-postgres/u.test(packageJson.scripts['test:phase5:evidence-class'] ?? ''), false);
});

test('R5-09 closed schema freezes evidence class contract and gate catalogs', () => {
  const schema = JSON.parse(
    readSource('tests/fixtures/phase5/remediation/r5-09-evidence-class.schema.json'),
  ) as {
    additionalProperties: boolean;
    required: readonly string[];
    properties: {
      format: { const: string };
      task: { const: string };
      evidenceClasses: { prefixItems: ReadonlyArray<{ const: string }> };
      capabilityProofAllowedClasses: { prefixItems: ReadonlyArray<{ const: string }> };
    };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-09.v1');
  assert.equal(schema.properties.task.const, 'R5-09');
  assert.deepEqual(
    schema.properties.evidenceClasses.prefixItems.map((item) => item.const),
    ['supporting', 'verified'],
  );
  assert.deepEqual(
    schema.properties.capabilityProofAllowedClasses.prefixItems.map((item) => item.const),
    ['verified'],
  );
  for (const key of [
    'format', 'task', 'evidenceClasses', 'capabilityProofAllowedClasses',
    'productionSurfaces', 'supportingSurfaces', 'catalogs', 'rules',
  ]) {
    assert.ok(schema.required.includes(key), `schema must require ${key}`);
  }
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate({ format: 'known.phase5.remediation.r5-09.v1', task: 'R5-09' }), false);
});

test('R5-09 module freezes closed classes and does not infer class from command names', () => {
  assert.deepEqual([...EVIDENCE_CLASSES], ['supporting', 'verified']);
  assert.deepEqual([...CAPABILITY_PROOF_ALLOWED_CLASSES], ['verified']);
  assert.ok(PRODUCTION_SURFACES.includes('postgresql'));
  assert.ok(SUPPORTING_SURFACES.includes('unit'));
  const moduleSource = readSource('scripts/phase5-evidence-class.mjs');
  assert.doesNotMatch(moduleSource, /command\.(?:includes|match|startsWith|endsWith).*evidenceClass/iu);
  assert.doesNotMatch(moduleSource, /infer.*(?:from )?command|commandName.*class/iu);
  assert.match(moduleSource, /GATE_CATALOGS/u);
  assert.match(moduleSource, /productionSurfaces/u);
});

test('R5-09 catalogs classify Follow/Feed/Notification/P5-26 gates without renaming unit to integration', () => {
  assert.equal(resolveGateClassification('follow', 'frontend').evidenceClass, 'supporting');
  assert.equal(resolveGateClassification('follow', 'frontend-build').evidenceClass, 'supporting');
  assert.equal(resolveGateClassification('follow', 'browser').evidenceClass, 'verified');
  assert.equal(resolveGateClassification('feed', 'event-contract').evidenceClass, 'supporting');
  assert.equal(resolveGateClassification('feed', 'worker').evidenceClass, 'verified');
  assert.equal(resolveGateClassification('notification', 'frontend').evidenceClass, 'supporting');
  assert.equal(resolveGateClassification('notification', 'browser').evidenceClass, 'verified');
  assert.equal(resolveGateClassification('free-social', 'contracts').evidenceClass, 'supporting');
  assert.equal(resolveGateClassification('free-social', 'static-quality').evidenceClass, 'supporting');
  assert.equal(resolveGateClassification('free-social', 'frontend-browser').evidenceClass, 'verified');
  const moduleSource = readSource('scripts/phase5-evidence-class.mjs');
  const testSource = readSource('tests/unit/phase5/phase5-evidence-class.test.ts');
  assert.doesNotMatch(moduleSource, /phase5-evidence-class\.integration/u);
  assert.doesNotMatch(testSource, /phase5-evidence-class\.integration/u);
  // Forbid promoting unit suites as integration evidence (avoid matching this assertion text).
  assert.doesNotMatch(moduleSource, /\brename(?:d)?\s+unit\s+(?:to\s+)?integration\b/iu);
  assert.doesNotMatch(
    testSource.replaceAll(/assert\.doesNotMatch\([\s\S]*?\);/gu, ''),
    /\brename(?:d)?\s+unit\s+(?:to\s+)?integration\b/iu,
  );
});

test('R5-09 rejects unknown evidence class', () => {
  assert.throws(
    () => resolveGateClassification('follow', 'not-a-real-gate'),
    /unknown gate|FAIL-CLOSED.*unknown/iu,
  );
  assert.throws(() => {
    attachGateEvidenceClass('follow', {
      id: 'browser',
      status: 'passed',
      command: 'x',
      durationMs: 0,
      resultSummary: 'ok',
      outputDigest: 'b'.repeat(64),
      evidenceClass: 'e2e',
    });
  }, /forged|unknown class|evidence class|FAIL-CLOSED/iu);
});

test('R5-09 rejects supporting-only capability proof', () => {
  const gates = [
    makeGate('follow', 'frontend'),
    makeGate('follow', 'frontend-build'),
  ];
  assert.throws(
    () => buildCapabilityProof({
      family: 'follow',
      gates,
      gateIds: ['frontend'],
    }),
    /supporting|capability proof|FAIL-CLOSED/iu,
  );
});

test('R5-09 rejects mixed proof when any referenced gate is supporting', () => {
  const gates = [
    makeGate('follow', 'browser'),
    makeGate('follow', 'frontend'),
  ];
  assert.throws(
    () => buildCapabilityProof({
      family: 'follow',
      gates,
      gateIds: ['browser', 'frontend'],
    }),
    /supporting|capability proof|FAIL-CLOSED/iu,
  );
  assert.throws(
    () => buildCapabilityEvidence({
      family: 'feed',
      gates: [makeGate('feed', 'event-contract')],
      gateId: 'event-contract',
    }),
    /supporting|capability proof|FAIL-CLOSED/iu,
  );
});

test('R5-09 rejects verified classification that lacks a production surface', () => {
  assert.throws(
    () => resolveGateClassification('follow', '__missing-surface__'),
    /unknown gate|FAIL-CLOSED/iu,
  );
  const moduleSource = readSource('scripts/phase5-evidence-class.mjs');
  assert.match(moduleSource, /productionSurfaces\.length|missing production surface/iu);
  for (const [family, catalog] of Object.entries(GATE_CATALOGS)) {
    for (const [gateId, entry] of Object.entries(catalog)) {
      if (entry.evidenceClass !== 'verified') continue;
      assert.ok(
        entry.productionSurfaces.length > 0,
        `${family}/${gateId} verified gate must declare production surfaces`,
      );
      for (const surface of entry.productionSurfaces) {
        assert.ok(PRODUCTION_SURFACES.includes(surface), `${family}/${gateId} unknown surface ${surface}`);
      }
    }
  }
});

test('R5-09 rejects forged evidenceClass that disagrees with the catalog', () => {
  assert.throws(() => {
    attachGateEvidenceClass('notification', {
      id: 'browser',
      status: 'passed',
      command: 'x',
      durationMs: 0,
      resultSummary: 'ok',
      outputDigest: 'c'.repeat(64),
      evidenceClass: 'supporting',
    });
  }, /forged|catalog|evidence class|FAIL-CLOSED/iu);
});

test('R5-09 acceptance schemas require closed evidenceClass and reject extra gate properties', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const relativePath of [
    'tests/fixtures/phase5/follow-acceptance-artifact.schema.json',
    'tests/fixtures/phase5/feed-acceptance-artifact.schema.json',
    'tests/fixtures/phase5/notification-acceptance-artifact.schema.json',
    'tests/fixtures/phase5/free-social-acceptance-artifact.schema.json',
  ]) {
    const schema = JSON.parse(readSource(relativePath)) as {
      $defs: {
        gate: {
          required: string[];
          additionalProperties: boolean;
          properties: { evidenceClass: unknown };
        };
        proof?: {
          required: string[];
          properties: { evidenceClass: { const: string } };
        };
        evidence?: {
          required: string[];
          properties: { evidenceClass: { const: string } };
        };
      };
    };
    assert.ok(schema.$defs.gate.required.includes('evidenceClass'), relativePath);
    assert.equal(schema.$defs.gate.additionalProperties, false);
    assert.ok(schema.$defs.gate.properties.evidenceClass, relativePath);
    if (schema.$defs.proof) {
      assert.ok(schema.$defs.proof.required.includes('evidenceClass'), relativePath);
      assert.equal(schema.$defs.proof.properties.evidenceClass.const, 'verified');
    }
    if (schema.$defs.evidence) {
      assert.ok(schema.$defs.evidence.required.includes('evidenceClass'), relativePath);
      assert.equal(schema.$defs.evidence.properties.evidenceClass.const, 'verified');
    }
    const validateGate = ajv.compile({
      ...schema.$defs.gate,
      $defs: schema.$defs,
    });
    const baseGate = {
      id: 'browser',
      status: 'passed',
      command: 'npm run x',
      durationMs: 1,
      resultSummary: 'ok',
      outputDigest: 'd'.repeat(64),
      evidenceClass: 'verified',
      ...(relativePath.includes('notification')
        ? {
          startedAt: '2026-07-29T00:00:00.000Z',
          completedAt: '2026-07-29T00:00:01.000Z',
          exitCode: 0,
        }
        : {}),
    };
    assert.equal(validateGate({ ...baseGate, forgedExtra: true }), false, relativePath);
    assert.equal(validateGate({ ...baseGate, evidenceClass: 'e2e' }), false, relativePath);
  }
});

test('R5-09 corner: multi-gate proof fails when any gate is supporting', () => {
  const gates = [
    makeGate('free-social', 'follow-regression'),
    makeGate('free-social', 'feed-regression'),
    makeGate('free-social', 'contracts'),
  ];
  assert.throws(
    () => buildCapabilityProof({
      family: 'free-social',
      gates,
      gateIds: ['follow-regression', 'feed-regression', 'contracts'],
    }),
    /supporting|FAIL-CLOSED/iu,
  );
});

test('R5-09 corner: duplicate gate ids in a proof are rejected', () => {
  const gates = [
    makeGate('free-social', 'follow-regression'),
    makeGate('free-social', 'feed-regression'),
  ];
  assert.throws(
    () => buildCapabilityProof({
      family: 'free-social',
      gates,
      gateIds: ['follow-regression', 'follow-regression'],
    }),
    /duplicate|FAIL-CLOSED/iu,
  );
});

test('R5-09 corner: digest changes when gate id order changes', () => {
  const digestA = '1'.repeat(64);
  const digestB = '2'.repeat(64);
  const gates = [
    makeGate('free-social', 'follow-regression', digestA),
    makeGate('free-social', 'feed-regression', digestB),
  ];
  const left = buildCapabilityProof({
    family: 'free-social',
    gates,
    gateIds: ['follow-regression', 'feed-regression'],
  });
  const right = buildCapabilityProof({
    family: 'free-social',
    gates,
    gateIds: ['feed-regression', 'follow-regression'],
  });
  assert.notEqual(digest(left), digest(right));
  assert.notDeepEqual(left.evidenceDigests, right.evidenceDigests);
  assert.notDeepEqual(left.gateIds, right.gateIds);
});

test('R5-09 verified capability proof and evidence builders succeed for catalog verified gates', () => {
  const followGates = [
    makeGate('follow', 'migration'),
    makeGate('follow', 'browser'),
    makeGate('follow', 'frontend'),
  ];
  const evidence = buildCapabilityEvidence({
    family: 'follow',
    gates: followGates,
    gateId: 'browser',
  });
  assert.equal(evidence.evidenceClass, 'verified');
  assert.equal(evidence.gateId, 'browser');

  const freeSocialGates = [
    makeGate('free-social', 'follow-regression'),
    makeGate('free-social', 'frontend-browser'),
  ];
  const proof = buildCapabilityProof({
    family: 'free-social',
    gates: freeSocialGates,
    gateIds: ['follow-regression', 'frontend-browser'],
  });
  assert.equal(proof.evidenceClass, 'verified');
  assert.deepEqual(proof.gateIds, ['follow-regression', 'frontend-browser']);

  const notificationGates = [
    makeGate('notification', 'worker'),
    makeGate('notification', 'browser'),
  ];
  const notificationProof = buildNotificationCapabilityProof({
    gates: notificationGates,
    gateId: 'browser',
    evidenceDigest: 'e'.repeat(64),
  });
  assert.equal(notificationProof.evidenceClass, 'verified');
  const combined = buildNotificationCapabilityProof({
    gates: notificationGates,
    gateId: 'worker+browser',
    sourceGateIds: ['worker', 'browser'],
    gateOutputDigest: 'f'.repeat(64),
    evidenceDigest: 'e'.repeat(64),
  });
  assert.equal(combined.evidenceClass, 'verified');
  assert.throws(
    () => buildNotificationCapabilityProof({
      gates: [...notificationGates, makeGate('notification', 'frontend')],
      gateId: 'worker+frontend',
      sourceGateIds: ['worker', 'frontend'],
      gateOutputDigest: 'f'.repeat(64),
      evidenceDigest: 'e'.repeat(64),
    }),
    /supporting|FAIL-CLOSED/iu,
  );
});

test('R5-09 runners attach evidenceClass, reject supporting proofs, keep real-stack and secret scan', () => {
  for (const relativePath of [
    'scripts/phase5-follow-acceptance.mjs',
    'scripts/phase5-feed-acceptance.mjs',
    'scripts/phase5-notification-acceptance.mjs',
    'scripts/phase5-free-social-acceptance.mjs',
  ]) {
    const source = readSource(relativePath);
    assert.match(source, /phase5-evidence-class\.mjs/u, relativePath);
    assert.match(source, /attachGateEvidenceClass|buildCapability/u, relativePath);
    assert.match(source, /real-stack-chromium/u, relativePath);
    assert.match(source, /assertSecretSafe|assertArtifactSecretSafe/u, relativePath);
    assert.doesNotMatch(source, /evidenceClass:\s*['"]verified['"].*command\.(?:includes|match)/u);
  }
  const freeSocial = readSource('scripts/phase5-free-social-acceptance.mjs');
  assert.match(freeSocial, /buildCapabilityProof/u);
  assert.doesNotMatch(
    freeSocial,
    /proof\(\s*['"]contracts['"]|proof\([^)]*['"]contracts['"]/u,
  );
  const feed = readSource('scripts/phase5-feed-acceptance.mjs');
  assert.doesNotMatch(feed, /evidenceFor\(\s*['"]event-contract['"]\s*\)/u);
});

test('R5-09 evidence documents describe closed evidenceClass separation', () => {
  for (const relativePath of [
    'docs/evidence/phase5-follow-acceptance-2026-07-29.md',
    'docs/evidence/phase5-feed-acceptance-2026-07-29.md',
    'docs/evidence/phase5-notification-acceptance-2026-07-29.md',
    'docs/evidence/phase5-free-social-acceptance-2026-07-29.md',
  ]) {
    const doc = readSource(relativePath);
    assert.match(doc, /evidenceClass/u, relativePath);
    assert.match(doc, /supporting/u, relativePath);
    assert.match(doc, /verified/u, relativePath);
  }
});
