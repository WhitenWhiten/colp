import { expect, test } from 'vitest';
import { CLASSIFICATION_POLICY } from '../../../src/modules/collections/application/classification-policy.js';
import {
  ClassificationProviderError,
  type BookmarkClassificationProvider,
} from '../../../src/modules/collections/application/classification-provider.js';
import {
  classificationCallProvenNotAccepted,
  type ClassificationExecutionLease,
  type ClassificationExecutionStore,
} from '../../../src/modules/collections/application/classification-execution.js';
import { runClassificationExecution } from '../../../src/modules/collections/application/run-classification-execution.js';

/**
 * Only a failure that proves the upstream never accepted the request may release
 * the dispatch reservation. A `deadline` raised before any request body left the
 * process qualifies; a mid-flight abort is mapped to `outcome_unknown` upstream
 * and must stay charged.
 */
test('only proven-not-accepted failures release the dispatch reservation', () => {
  expect(classificationCallProvenNotAccepted(new ClassificationProviderError('credentials'))).toBe(true);
  expect(classificationCallProvenNotAccepted(new ClassificationProviderError('rate_limited', 2))).toBe(true);
  expect(classificationCallProvenNotAccepted(new ClassificationProviderError('deadline'))).toBe(true);
  expect(classificationCallProvenNotAccepted(new ClassificationProviderError('contract_drift'))).toBe(false);
  expect(classificationCallProvenNotAccepted(new ClassificationProviderError('outcome_unknown'))).toBe(false);
  expect(classificationCallProvenNotAccepted(new Error('deadline'))).toBe(false);
  expect(classificationCallProvenNotAccepted(null)).toBe(false);
});

function lease(): ClassificationExecutionLease {
  return {
    id: 'exec-1', generation: '1',
    binding: { principalId: 'principal', commandScope: 'collections:classification-preview:v1', commandId: 'command' },
    ownerSubjectId: 'subject', collectionId: 'collection', fingerprint: 'fingerprint', requestId: 'request-1',
    providerId: 'cloudflare_jev', model: 'typesafe/jev',
    policyVersion: CLASSIFICATION_POLICY.version, promptVersion: CLASSIFICATION_POLICY.promptVersion,
    deadlineAt: new Date(Date.now() + 15_000).toISOString(),
    context: {
      bookmark: { url: 'https://example.org', title: 'Example', description: 'Description' },
      requested: { folder: true, tags: false },
      collection: { title: 'Library', summary: null },
      candidates: null,
      snapshot: {
        collectionId: 'collection', title: 'Library', summary: null,
        folders: [{ id: 'f1', parentId: null, title: 'Alpha', description: 'Alpha' }],
        tagUsage: [], node: null, contentRevision: 1, hostnameEvidence: null,
        settings: {
          collectionId: 'collection', autoTagMode: 'off', maxAutoTags: 3,
          executionMode: 'server_managed', providerProfileId: null,
        },
      },
    },
    billingMode: 'legacy_free', creditChargeId: null, billingOwnerKind: 'execution',
  } as unknown as ClassificationExecutionLease;
}

interface Recorded { readonly rejections: { notAccepted: boolean; attempts: number | undefined }[]; readonly finishes: { state: string; failureCode: string | undefined }[] }

function harness(failure: unknown) {
  const recorded: Recorded = { rejections: [], finishes: [] };
  const leaseValue = lease();
  const store: ClassificationExecutionStore = {
    lookup: async () => null,
    admit: async () => ({ kind: 'accepted', executionId: leaseValue.id }),
    lease: async () => leaseValue,
    heartbeat: async () => true,
    prepare: async () => null,
    dispatch: async () => {},
    completeCall: async () => {},
    rejectCall: async (_lease, _stage, _chunk, notAccepted, attempts) => { recorded.rejections.push({ notAccepted, attempts }); },
    finish: async (_lease, state, _result, failureCode) => { recorded.finishes.push({ state, failureCode }); return true; },
    pending: async () => [],
    reap: async () => 0,
  };
  const provider: BookmarkClassificationProvider = {
    id: 'cloudflare_jev', model: 'typesafe/jev',
    policyVersion: CLASSIFICATION_POLICY.version, promptVersion: CLASSIFICATION_POLICY.promptVersion,
    capabilities: { idempotency: false },
    classify: async (_input, execution) => {
      await execution.calls.run('l1', 0, { probe: true }, async () => { throw failure; });
      throw new Error('unreachable');
    },
  };
  return { store, provider, lease: leaseValue, recorded };
}

async function run(failure: unknown) {
  const built = harness(failure);
  const errors: string[] = [];
  await runClassificationExecution(built.store, built.provider, built.lease.id, {
    enabled: () => true, onError: code => errors.push(code),
  });
  return { ...built, errors };
}

test('a pre-send deadline releases the reservation and finishes as a failure', async () => {
  const result = await run(new ClassificationProviderError('deadline'));
  expect(result.recorded.rejections).toEqual([{ notAccepted: true, attempts: undefined }]);
  expect(result.recorded.finishes).toEqual([{ state: 'failed', failureCode: 'deadline' }]);
  expect(result.errors).toEqual(['deadline']);
});

test('a rate-limited retry that never dispatched releases the reservation', async () => {
  const result = await run(new ClassificationProviderError('rate_limited', 2));
  expect(result.recorded.rejections).toEqual([{ notAccepted: true, attempts: 2 }]);
  expect(result.recorded.finishes).toEqual([{ state: 'failed', failureCode: 'rate_limited' }]);
});

test('a rejected credential releases the reservation', async () => {
  const result = await run(new ClassificationProviderError('credentials'));
  expect(result.recorded.rejections).toEqual([{ notAccepted: true, attempts: undefined }]);
  expect(result.recorded.finishes).toEqual([{ state: 'failed', failureCode: 'credentials' }]);
});

test('an uncertain outcome keeps the reservation and never retries', async () => {
  const result = await run(new ClassificationProviderError('outcome_unknown'));
  // `outcome_unknown` is deliberately absent from the reject list: the attempt
  // stays dispatching so `finish` can settle it at the full reservation.
  expect(result.recorded.rejections).toEqual([]);
  expect(result.recorded.finishes).toEqual([{ state: 'outcome_unknown', failureCode: 'outcome_unknown' }]);
});

test('a response-shape failure keeps the reservation because tokens may be spent', async () => {
  const result = await run(new ClassificationProviderError('contract_drift'));
  expect(result.recorded.rejections).toEqual([{ notAccepted: false, attempts: undefined }]);
  expect(result.recorded.finishes).toEqual([{ state: 'failed', failureCode: 'contract_drift' }]);
});
