/**
 * V4A-01 verification remediation contract test (plan §4 V4A-01): pins the
 * machine-readable Phase 4A verification remediation contract, its closed
 * schema and the standalone verifier, and proves the verifier fails closed
 * on every frozen rejection condition: same-process API, worker direct
 * call, missing delivery PID, current mode bound to an old revision,
 * delivery generic DB role, missing no-referrer/no-store, premature
 * Verified, a status table that regresses to Verified, and an
 * owner-private evidence document that regresses to PENDING.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/phase4a');
const contractPath = resolve(fixtureRoot, 'verification-remediation-contract.v1.json');
const schemaPath = resolve(fixtureRoot, 'verification-remediation-contract.schema.json');
const verifierPath = resolve(backendRoot, 'scripts/verify-phase4a-verification-remediation-contract.mjs');
const statusDocPath = resolve(backendRoot, 'docs/09-phase-execution-status.md');
const evidenceDocPath = resolve(backendRoot, 'docs/evidence/phase4a-owner-private.md');

interface HistoricalRun {
  id: string;
  revision: string;
  artifact: string;
  role: string;
}

interface RemediationTask {
  id: string;
  commitSubject: string;
  owner: string;
  finalAcceptance: string;
  focusedGates: string[];
  evidenceClass: string;
}

interface VerificationRemediationContract {
  format: string;
  contractVersion: number;
  planDocument: string;
  authoritativeStatus: {
    status: string;
    verifiedOnlyAfterTask: string;
    deploymentProven: boolean;
    historicalEvidenceIsAuditOnly: boolean;
    historicalEvidenceDoesNotProveHead: boolean;
    statusDocument: string;
    ownerPrivateEvidenceDocument: string;
    ownerPrivateEvidenceDocumentStatus: string;
    historicalRuns: HistoricalRun[];
  };
  topology: {
    kind: string;
    requiredProcesses: string[];
    distinctOsPids: boolean;
    transport: string;
    forbiddenSubstitutes: string[];
    runnerRecords: string[];
  };
  evidenceHierarchy: {
    levels: { id: string; proves: string[]; cannotReplace: string[] }[];
    finalVerifiedRequires: string[];
    sameFreshCanonicalRun: boolean;
    deploymentProven: boolean;
  };
  validationModes: {
    defaultMode: string;
    modes: {
      id: string;
      sourceBinding: string;
      bindsRevision: boolean;
      replayableOnBoundRevision: boolean;
      requiresSourceEqualsHead?: boolean;
      oldRevisionFailsWithStableCode?: boolean;
    }[];
    forbidCurrentMigrationRejectingHistoricalArtifact: boolean;
    historicalPassDoesNotProveHead: boolean;
  };
  deliveryCredentialBoundary: {
    allowed: string[];
    forbidden: string[];
    documentationWording: string;
    keepCurrentActiveFencing: boolean;
  };
  urlSecretContract: {
    capabilityIsBearerSecret: boolean;
    requiredResponseHeaders: { name: string; value: string }[];
    headersOnSuccessAndErrorResponses: boolean;
    logScope: string;
    tokenFingerprintDefaultOff: boolean;
    forbidRawPathQueryLogging: boolean;
    forbidPersistingRealPath: boolean;
    ingressContractRequired: boolean;
  };
  tasks: RemediationTask[];
}

function runVerifier(extraArgs: string[] = []) {
  return spawnSync(process.execPath, [verifierPath, ...extraArgs], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
}

function readContract(): VerificationRemediationContract {
  return JSON.parse(readFileSync(contractPath, 'utf8')) as VerificationRemediationContract;
}

function mutateContract(mutate: (contract: VerificationRemediationContract) => void): string {
  const contract = readContract();
  mutate(contract);
  const directory = mkdtempSync(join(tmpdir(), 'known-phase4a-vr-contract-'));
  const path = join(directory, 'contract.json');
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return path;
}

function mutateTextFile(sourcePath: string, mutate: (source: string) => string): string {
  const directory = mkdtempSync(join(tmpdir(), 'known-phase4a-vr-doc-'));
  const path = join(directory, 'document.md');
  writeFileSync(path, mutate(readFileSync(sourcePath, 'utf8')), 'utf8');
  return path;
}

test('V4A-01 registers the verification-remediation-contract focused gate', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts['test:phase4a:verification-remediation-contract'] ?? '',
    /phase4a-verification-remediation-contract\.test\.ts/u,
  );
});

test('V4A-01 freezes the four-PID topology, evidence hierarchy and validation modes', () => {
  const contract = readContract();
  assert.equal(contract.format, 'known.phase4a.verification-remediation.v1');
  assert.equal(contract.contractVersion, 1);
  assert.deepEqual(contract.topology.requiredProcesses, ['api-a', 'api-b', 'worker', 'delivery']);
  assert.equal(contract.topology.kind, 'independent-os-processes');
  assert.equal(contract.topology.distinctOsPids, true);
  assert.equal(contract.topology.transport, 'real-listening-socket');
  assert.ok(contract.topology.forbiddenSubstitutes.includes('fastify-inject'));
  assert.ok(contract.topology.forbiddenSubstitutes.includes('same-process-composition'));
  assert.ok(contract.topology.forbiddenSubstitutes.includes('direct-worker-method-call'));
  assert.deepEqual(contract.evidenceHierarchy.levels.map((level) => level.id),
    ['supporting', 'process-verified', 'environment-verified']);
  assert.deepEqual(contract.evidenceHierarchy.finalVerifiedRequires,
    ['process-verified', 'environment-verified']);
  assert.equal(contract.evidenceHierarchy.sameFreshCanonicalRun, true);
  assert.equal(contract.evidenceHierarchy.deploymentProven, false);
  assert.equal(contract.validationModes.defaultMode, 'retained');
  assert.deepEqual(contract.validationModes.modes.map((mode) => mode.id), ['retained', 'current']);
  assert.equal(contract.validationModes.modes[0]!.sourceBinding, 'artifact-source-revision');
  assert.equal(contract.validationModes.modes[0]!.replayableOnBoundRevision, true);
  assert.equal(contract.validationModes.modes[1]!.sourceBinding, 'head');
  assert.equal(contract.validationModes.modes[1]!.requiresSourceEqualsHead, true);
  assert.equal(contract.validationModes.modes[1]!.oldRevisionFailsWithStableCode, true);
  assert.equal(contract.validationModes.forbidCurrentMigrationRejectingHistoricalArtifact, true);
  assert.equal(contract.validationModes.historicalPassDoesNotProveHead, true);
});

test('V4A-01 freezes the delivery credential boundary and URL-secret contract', () => {
  const contract = readContract();
  assert.deepEqual(contract.deliveryCredentialBoundary.allowed,
    ['r2-read-only', 'capability-hmac-secret', 'delivery-postgres-read-only-role']);
  for (const forbidden of [
    'known-session',
    'r2-read-write',
    'generic-application-db-role',
    'physical-key-in-capability',
    'absolute-credential-free-wording',
  ]) {
    assert.ok(contract.deliveryCredentialBoundary.forbidden.includes(forbidden), forbidden);
  }
  assert.equal(contract.deliveryCredentialBoundary.documentationWording,
    'session-free, r2-read-only, db-read-only');
  assert.equal(contract.deliveryCredentialBoundary.keepCurrentActiveFencing, true);
  assert.equal(contract.urlSecretContract.capabilityIsBearerSecret, true);
  assert.deepEqual(contract.urlSecretContract.requiredResponseHeaders, [
    { name: 'referrer-policy', value: 'no-referrer' },
    { name: 'cache-control', value: 'no-store' },
    { name: 'x-content-type-options', value: 'nosniff' },
  ]);
  assert.equal(contract.urlSecretContract.headersOnSuccessAndErrorResponses, true);
  assert.equal(contract.urlSecretContract.logScope, 'route-template-or-fixed-token-fingerprint');
  assert.equal(contract.urlSecretContract.tokenFingerprintDefaultOff, true);
  assert.equal(contract.urlSecretContract.forbidRawPathQueryLogging, true);
  assert.equal(contract.urlSecretContract.forbidPersistingRealPath, true);
  assert.equal(contract.urlSecretContract.ingressContractRequired, true);
});

test('V4A-01 freezes the authoritative status and V4A-00..V4A-08 unique owners', () => {
  const contract = readContract();
  assert.equal(contract.authoritativeStatus.status,
    'Implemented / Awaiting current-revision acceptance');
  assert.equal(contract.authoritativeStatus.verifiedOnlyAfterTask, 'V4A-08');
  assert.equal(contract.authoritativeStatus.deploymentProven, false);
  assert.equal(contract.authoritativeStatus.historicalEvidenceIsAuditOnly, true);
  assert.equal(contract.authoritativeStatus.historicalEvidenceDoesNotProveHead, true);
  assert.equal(contract.authoritativeStatus.ownerPrivateEvidenceDocumentStatus, 'AUDIT RECORD');
  assert.deepEqual(contract.authoritativeStatus.historicalRuns.map((run) => run.id), ['I16', 'P11']);
  assert.deepEqual(contract.authoritativeStatus.historicalRuns.map((run) => run.revision), ['af9711f', '3d538cd']);
  assert.ok(contract.authoritativeStatus.historicalRuns.every((run) => run.role === 'audit-record'));

  const tasks = contract.tasks;
  assert.equal(tasks.length, 9);
  assert.deepEqual(tasks.map((task) => task.id),
    Array.from({ length: 9 }, (_, index) => `V4A-${String(index).padStart(2, '0')}`));
  assert.equal(new Set(tasks.map((task) => task.owner)).size, 9,
    'V4A-00 mainline plus V4A-01..V4A-08 must each own exactly one task');
  assert.deepEqual(tasks.map((task) => task.owner),
    ['mainline', 'V4A-01', 'V4A-02', 'V4A-03', 'V4A-04', 'V4A-05', 'V4A-06', 'V4A-07', 'V4A-08']);
  for (const task of tasks) {
    assert.match(task.finalAcceptance, /^V4A-\d{2}(?:,V4A-\d{2})*$/u);
    assert.ok(task.focusedGates.length >= 1);
    assert.ok(['supporting', 'process-verified', 'environment-verified'].includes(task.evidenceClass));
  }
  assert.equal(tasks[4]!.finalAcceptance, 'V4A-06,V4A-08');
  assert.equal(tasks[6]!.finalAcceptance, 'V4A-07,V4A-08');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    additionalProperties: boolean;
  };
  assert.equal(schema.additionalProperties, false);
});

test('V4A-01 verifier rejects same-process API and worker direct calls', () => {
  const sameProcess = mutateContract((contract) => {
    contract.topology.transport = 'fastify-inject';
  });
  let result = runVerifier(['--contract', sameProcess]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:real listening sockets|topology\/transport)/iu);

  const workerDirect = mutateContract((contract) => {
    contract.topology.forbiddenSubstitutes =
      contract.topology.forbiddenSubstitutes.filter((item) => item !== 'direct-worker-method-call');
  });
  result = runVerifier(['--contract', workerDirect]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*direct-worker-method-call/iu);
});

test('V4A-01 verifier rejects a topology without the delivery PID', () => {
  const path = mutateContract((contract) => {
    contract.topology.requiredProcesses = ['api-a', 'api-b', 'worker'];
  });
  const result = runVerifier(['--contract', path]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:delivery PID|requiredProcesses)/iu);
});

test('V4A-01 verifier rejects current mode bound to an old revision', () => {
  const path = mutateContract((contract) => {
    contract.validationModes.modes[1]!.requiresSourceEqualsHead = false;
    contract.validationModes.modes[1]!.sourceBinding = 'artifact-source-revision';
  });
  const result = runVerifier(['--contract', path]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*current mode must require artifact source/iu);
});

test('V4A-01 verifier rejects a delivery generic application DB role', () => {
  const path = mutateContract((contract) => {
    contract.deliveryCredentialBoundary.allowed.push('generic-application-db-role');
  });
  const result = runVerifier(['--contract', path]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:generic application DB roles|dedicated DB read-only role)/iu);
});

test('V4A-01 verifier rejects missing no-referrer/no-store headers', () => {
  for (const [label, headerName] of [
    ['no-referrer', 'referrer-policy'],
    ['no-store', 'cache-control'],
  ] as const) {
    const path = mutateContract((contract) => {
      contract.urlSecretContract.requiredResponseHeaders =
        contract.urlSecretContract.requiredResponseHeaders
          .filter((header) => header.name !== headerName);
    });
    const result = runVerifier(['--contract', path]);
    assert.notEqual(result.status, 0, label);
    assert.match(`${result.stdout}${result.stderr}`,
      /FAIL-CLOSED.*(?:Referrer-Policy: no-referrer, Cache-Control: no-store|requiredResponseHeaders)/iu,
      label);
  }
});

test('V4A-01 verifier rejects premature Verified in the contract', () => {
  const path = mutateContract((contract) => {
    contract.authoritativeStatus.status = 'Verified';
    contract.authoritativeStatus.verifiedOnlyAfterTask = 'V4A-01';
  });
  const result = runVerifier(['--contract', path]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*premature Verified/iu);
});

test('V4A-01 verifier rejects a Verified status row that lacks V4A-08 seal facts', () => {
  const statusDoc = mutateTextFile(statusDocPath, (source) =>
    source.replace('deploymentProven=false', 'deploymentProven=true'));
  const result = runVerifier(['--status-doc', statusDoc]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*Verified Phase 4A must record deploymentProven=false/iu);
});

test('V4A-01 verifier rejects an owner-private evidence document that regresses to PENDING', () => {
  const evidenceDoc = mutateTextFile(evidenceDocPath, (source) =>
    source.replace('状态：**AUDIT RECORD', '状态：**PENDING'));
  const result = runVerifier(['--evidence-doc', evidenceDoc]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*must not declare PENDING/iu);
});

test('V4A-01 verifier rejects duplicate task owners and wrong commit order', () => {
  const duplicateOwner = mutateContract((contract) => {
    contract.tasks[2]!.owner = 'V4A-01';
  });
  let result = runVerifier(['--contract', duplicateOwner]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*unique owner/iu);

  const wrongOrder = mutateContract((contract) => {
    const tasks = contract.tasks.slice();
    const temporary = tasks[1]!;
    tasks[1] = tasks[2]!;
    tasks[2] = temporary;
    contract.tasks = tasks;
  });
  result = runVerifier(['--contract', wrongOrder]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`,
    /FAIL-CLOSED.*(?:owner\/order|commit order|strictly ordered)/iu);
});

test('V4A-01 verifier accepts the frozen contract with the authoritative documents', () => {
  const result = runVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /phase4a verification remediation contracts verified/u);
});
