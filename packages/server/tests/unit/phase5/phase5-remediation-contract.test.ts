import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/phase5');
const contractPath = resolve(fixtureRoot, 'free-social-contract.v1.json');
const verifierPath = resolve(backendRoot, 'scripts/verify-phase5-free-social-contract.mjs');
const remediationSchemaPath = resolve(fixtureRoot, 'free-social-remediation.schema.json');

interface RemediationTask {
  id: string;
  commitSubject: string;
  owner: string;
  finalAcceptance: string;
  evidenceClass: string;
  publicCommands: string[];
  closedSchema: string;
}

interface RemediationContract {
  format: string;
  planDocument: string;
  fanout: {
    transport: string;
    pageSizeEnv: string;
    defaultPageSize: number;
    minPageSize: number;
    maxPageSize: number;
    cursorStorage: string;
    continuation: {
      kind: string;
      callsFail: boolean;
      subjectToMaxAttempts: boolean;
      writesLastError: boolean;
      forbiddenSubstitutes: string[];
    };
    writeStrategy: string;
    forbidPerRecipientClientQuery: boolean;
    index: {
      name: string;
      columns: string[];
      include: string[];
    };
  };
  withdrawal: {
    outboxType: string;
    appendInFollowCommandTransaction: boolean;
    independentOutboxRow: boolean;
    retainQueryTimeRecheck: boolean;
    requiredHandler: string;
  };
  identity: {
    socialNotificationsTextMaxLength: number;
    openapiProfileStableIdLength: number;
  };
  queryUnitOfWork: {
    surfaces: string[];
    isolation: string;
    clock: string;
    forbidAdapterWallClock: boolean;
  };
  evidence: {
    lockPathField: string;
    forbidAbsoluteArtifactPath: boolean;
    runtimeRootEnv: string;
    runtimeRootMustBeAbsolute: boolean;
    negativeControls: {
      mode: string;
      forbidEmptyStringSimulation: boolean;
      forbidManualBooleanSimulation: boolean;
    };
    evidenceClasses: string[];
    capabilityProofAllowedClasses: string[];
    supportingOnlySurfaces: string[];
    canonicalBindingMode: string;
  };
  tasks: RemediationTask[];
}

interface Phase5ContractFixture {
  remediation: RemediationContract;
  [key: string]: unknown;
}

function runVerifier(contract = contractPath) {
  return spawnSync(process.execPath, [verifierPath, '--contract', contract], {
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
  const directory = mkdtempSync(join(tmpdir(), 'known-phase5-remediation-'));
  const path = join(directory, 'contract.json');
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return path;
}

test('R5-01 exposes remediation-contract focused gate that regresses verify:phase5:contracts', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts['test:phase5:remediation-contract'] ?? '',
    /phase5-remediation-contract\.test\.ts/u,
  );
  assert.match(
    packageJson.scripts['test:phase5:remediation-contract'] ?? '',
    /verify:phase5:contracts/u,
  );
  assert.equal(
    packageJson.scripts['verify:phase5:contracts'],
    'vitest run tests/unit/phase5/phase5-free-social-contract.test.ts',
  );
});

test('R5-01 freezes section-1 remediation semantics in the machine contract', () => {
  const remediation = readContract().remediation;
  assert.equal(remediation.format, 'known.phase5.free-social-remediation.v1');
  assert.equal(remediation.fanout.transport, 'existing-outbox');
  assert.equal(remediation.fanout.pageSizeEnv, 'FEED_FANOUT_PAGE_SIZE');
  assert.equal(remediation.fanout.defaultPageSize, 500);
  assert.equal(remediation.fanout.minPageSize, 1);
  assert.equal(remediation.fanout.maxPageSize, 1000);
  assert.equal(remediation.fanout.cursorStorage, 'social_feed_watermarks');
  assert.equal(remediation.fanout.continuation.kind, 'normal-control-flow');
  assert.equal(remediation.fanout.continuation.callsFail, false);
  assert.equal(remediation.fanout.continuation.subjectToMaxAttempts, false);
  assert.equal(remediation.fanout.continuation.writesLastError, false);
  assert.ok(remediation.fanout.continuation.forbiddenSubstitutes.includes('ordinary-retry'));
  assert.equal(remediation.fanout.writeStrategy, 'set-based-sql');
  assert.equal(remediation.fanout.forbidPerRecipientClientQuery, true);
  assert.deepEqual(remediation.fanout.index, {
    name: 'follows_target_actor_fanout_idx',
    columns: ['target_profile_id', 'actor_profile_id ASC'],
    include: ['followed_at'],
  });
  assert.equal(remediation.withdrawal.outboxType, 'social_feed_withdrawal');
  assert.equal(remediation.withdrawal.requiredHandler, 'social_feed_withdrawal');
  assert.equal(remediation.withdrawal.retainQueryTimeRecheck, true);
  assert.equal(remediation.identity.socialNotificationsTextMaxLength, 256);
  assert.equal(remediation.identity.openapiProfileStableIdLength, 22);
  assert.equal(remediation.queryUnitOfWork.isolation, 'repeatable-read');
  assert.equal(remediation.queryUnitOfWork.clock, 'postgresql-current_timestamp');
  assert.equal(remediation.evidence.lockPathField, 'relativePath');
  assert.equal(remediation.evidence.forbidAbsoluteArtifactPath, true);
  assert.equal(remediation.evidence.runtimeRootEnv, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(remediation.evidence.canonicalBindingMode, 'exact-commit');
  assert.deepEqual(remediation.evidence.capabilityProofAllowedClasses, ['verified']);
  assert.deepEqual(remediation.evidence.evidenceClasses, ['supporting', 'verified']);
});

test('R5-01 binds R5-01..R5-18 with unique owners, final acceptance, commands, and closed schemas', () => {
  const tasks = readContract().remediation.tasks;
  assert.equal(tasks.length, 18);
  assert.deepEqual(tasks.map((task) => task.id), Array.from({ length: 18 }, (_, index) =>
    `R5-${String(index + 1).padStart(2, '0')}`));
  assert.equal(new Set(tasks.map((task) => task.id)).size, 18);
  for (const task of tasks) {
    assert.match(task.owner, /^(contracts|social|outbox|notifications|operations|release)$/u);
    assert.match(task.finalAcceptance, /^R5-\d{2}(?:,R5-\d{2})*$/u);
    assert.ok(task.publicCommands.length >= 1);
    for (const command of task.publicCommands) {
      assert.match(command, /^npm run (?:test|evidence|verify):phase5:/u);
    }
    assert.match(task.closedSchema, /^tests\/fixtures\/phase5\//u);
    assert.ok(!task.closedSchema.includes(':\\') && !task.closedSchema.startsWith('/'));
    assert.ok(['supporting', 'verified'].includes(task.evidenceClass));
  }
  const schema = JSON.parse(readFileSync(remediationSchemaPath, 'utf8')) as {
    additionalProperties: boolean;
  };
  assert.equal(schema.additionalProperties, false);
});

test('R5-01 verifier rejects page size drift including illegal 0 and 1001', () => {
  for (const [label, mutate] of [
    ['default', (contract: Phase5ContractFixture) => {
      contract.remediation.fanout.defaultPageSize = 1000;
    }],
    ['min', (contract: Phase5ContractFixture) => {
      contract.remediation.fanout.minPageSize = 0;
    }],
    ['max', (contract: Phase5ContractFixture) => {
      contract.remediation.fanout.maxPageSize = 1001;
    }],
  ] as const) {
    const path = mutateContract(mutate);
    const result = runVerifier(path);
    assert.notEqual(result.status, 0, label);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*page size/iu, label);
  }
});

test('R5-01 verifier rejects ordinary retry as continuation substitute', () => {
  const path = mutateContract((contract) => {
    contract.remediation.fanout.continuation.kind = 'ordinary-retry';
    contract.remediation.fanout.continuation.callsFail = true;
    contract.remediation.fanout.continuation.forbiddenSubstitutes =
      contract.remediation.fanout.continuation.forbiddenSubstitutes
        .filter((item) => item !== 'ordinary-retry');
  });
  const result = runVerifier(path);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*continuation/iu);
});

test('R5-01 verifier rejects missing withdrawal handler', () => {
  const path = mutateContract((contract) => {
    contract.remediation.withdrawal.requiredHandler = '';
    contract.remediation.withdrawal.outboxType = 'social.follow-removed';
  });
  const result = runVerifier(path);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*withdrawal/iu);
});

test('R5-01 verifier rejects absolute artifact path lock semantics', () => {
  const path = mutateContract((contract) => {
    contract.remediation.evidence.lockPathField = 'path';
    contract.remediation.evidence.forbidAbsoluteArtifactPath = false;
  });
  const result = runVerifier(path);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*absolute artifact path|relativePath/iu);
});

test('R5-01 verifier rejects supporting capability proof classes', () => {
  const path = mutateContract((contract) => {
    contract.remediation.evidence.capabilityProofAllowedClasses = ['verified', 'supporting'];
  });
  const result = runVerifier(path);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*capability proof|supporting/iu);
});

test('R5-01 verifier rejects Monetization expansion into remediation contracts', () => {
  const path = mutateContract((contract) => {
    (contract.remediation as unknown as { billingPlan?: string }).billingPlan = 'subscription';
  });
  const result = runVerifier(path);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*(?:Monetization|unknown|keys drifted)/iu);
});

test('R5-01 verifier rejects unknown fields, duplicate task owners, and wrong commit order', () => {
  const unknown = mutateContract((contract) => {
    (contract.remediation as unknown as { extraField?: boolean }).extraField = true;
  });
  let result = runVerifier(unknown);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*keys drifted|unknown/iu);

  const duplicateOwner = mutateContract((contract) => {
    contract.remediation.tasks[1]!.id = 'R5-01';
  });
  result = runVerifier(duplicateOwner);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*duplicate|task/iu);

  const wrongOrder = mutateContract((contract) => {
    const tasks = contract.remediation.tasks.slice();
    const temporary = tasks[1]!;
    tasks[1] = tasks[2]!;
    tasks[2] = temporary;
    contract.remediation.tasks = tasks;
  });
  result = runVerifier(wrongOrder);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*commit order|task order|R5-0/iu);
});

test('R5-01 verifier rejects illegal evidence class and missing exact-commit claim', () => {
  const illegalClass = mutateContract((contract) => {
    contract.remediation.evidence.evidenceClasses = ['supporting', 'verified', 'e2e'];
    contract.remediation.tasks[0]!.evidenceClass = 'e2e';
  });
  let result = runVerifier(illegalClass);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*evidence class/iu);

  const missingExactCommit = mutateContract((contract) => {
    contract.remediation.evidence.canonicalBindingMode = 'working-tree';
  });
  result = runVerifier(missingExactCommit);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*exact-commit/iu);
});

test('R5-01 verifier accepts the frozen remediation contract', () => {
  const result = runVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /free-social contracts verified/u);
});
