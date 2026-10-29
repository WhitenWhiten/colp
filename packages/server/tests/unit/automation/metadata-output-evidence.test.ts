import { expect, test, vi } from 'vitest';
import { submitResult, type ResultSubmissionPort, type WorkPrincipal } from '../../../src/modules/automation/index.js';
import type { Evidence, TaskSpec } from '@know-n/colp/automation';

const actor: WorkPrincipal = { accountId: 'owner', subjectId: 'subject', clientId: 'client', credentialBindingId: 'binding', scopes: ['automation:work'] };
const task: TaskSpec = { id: 'metadata', type: 'metadata.resolve', after: [], executorRole: 'worker', required: true,
  outputContract: 'metadata.sourced.v1', inputFields: ['title'], instruction: 'Resolve metadata' };
const evidence = (kind: Evidence['kind'], reference: string): Evidence => ({ kind, reference, observedAt: '2026-10-13T00:00:00Z' });
const source = evidence('source', 'source');
function fixture() {
  const prepare = vi.fn(async () => {});
  const reconcile = vi.fn(async () => ({ jobId: 'job', resultId: 'result', proposalDigest: 'a'.repeat(64), status: 'succeeded' as const, effectReceiptIds: [], diagnostics: [] }));
  const port: ResultSubmissionPort = { task: async () => ({ task, sourceReferences: ['source'] }), prepare, reconcile };
  const submit = (tags: { key: string; label: string; evidence: Evidence[] }[]) => submitResult(port, actor, 'job', {
    claimToken: 'claim', generation: 1, inputDigest: 'a'.repeat(64), outputContract: task.outputContract,
    output: { kind: 'metadata', catalogId: 'catalog', entities: [], evidence: [source], tags },
  });
  return { submit, prepare, reconcile };
}
test.each([
  ['foreign source', [evidence('source', 'foreign-source')]],
  ['model only', [evidence('model', 'provider')]],
  ['mixed pinned and foreign sources', [source, evidence('source', 'foreign-source')]],
  ['missing source', []],
])('rejects metadata tag with %s before persistence', async (_label, tagEvidence) => {
  const f = fixture();
  await expect(f.submit([{ key: 'tag', label: 'Tag', evidence: tagEvidence }])).rejects.toMatchObject({ code: 'invalid_request' });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.reconcile).not.toHaveBeenCalled();
});
test.each([
  ['sourced tags', [{ key: 'tag', label: 'Tag', evidence: [source] }]],
  ['empty tags', []],
])('accepts metadata with %s', async (_label, tags) => {
  const f = fixture();
  expect((await f.submit(tags)).status).toBe('succeeded');
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.reconcile).toHaveBeenCalledOnce();
});
