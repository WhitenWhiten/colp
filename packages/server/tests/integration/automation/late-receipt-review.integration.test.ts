import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { saveBinding, previewRule, setLifecycle, cancelAutomationRun, getAutomationRun,
  placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';

describeWithPostgres('late canonical evidence and cancelled run concurrency', () => {
  test('late device evidence adds history without reviving cancelled work or retaining its old ETag', async () => {
    const f = await automationDeviceFixture('late_receipt_review');
    try {
      await f.uow.execute(f.owner, async p => {
        await saveBinding(p, f.owner, { name: 'Constrained destination', values: { academicRoot: {
          ...f.values.academicRoot, allowedAncestor: { ...f.folder, nodeId: 'parent' },
        } } }, f.binding.id, '"1"');
        const current = await p.rules.load(f.owner.accountId, f.rule.id);
        const checked = await previewRule(p, f.owner, { rule: { definition: f.rule.definition, bindingSetId: f.binding.id }, mode: 'currentState' });
        await setLifecycle(p, f.owner, f.rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Enable constrained rule',
          activationPreviewId: checked.previewId }, `"${current!.view.revision}"`);
      });
      const device = createAutomationDeviceUnitOfWork(f.db, 'server');
      const auth = { credential: f.http.credential, origin: AUTOMATION_DEVICE_ORIGIN, sessionId: f.sessionId };
      const bundle = await device.execute(auth, p => p.bundle('browser-bounded-v1'));
      expect((await f.syncMove('academic', 'destination-out', 'root')).results[0]!.status).toBe('applied');
      await f.syncCreate('late-paper', 'late-create', 'root'); await f.inspect();
      const row = await f.db.selectFrom('automation_runs').select('id').executeTakeFirstOrThrow();
      const cancelled = await f.uow.execute(f.owner, async p => {
        const current = await getAutomationRun(p.runs, row.id); expect(current.status).toBe('review');
        return cancelAutomationRun(p.runs, row.id, `"${current.revision}"`);
      });
      expect((await f.syncMove('academic', 'destination-back', 'parent')).results[0]!.status).toBe('applied');
      const moved = await f.syncMove('late-paper', 'late-move'); expect(moved.results[0]!.status).toBe('applied');
      const pins = { committedNode: { ...f.folder, nodeId: 'late-paper' }, ruleRevision: '1', bindingRevision: '2' };
      const input = { ...pins, deviceId: f.replica.deviceId,
        replicaGeneration: Number(f.replica.leaseGeneration), localReceiptId: randomUUID(), bundleRevision: bundle.revision,
        ruleId: f.rule.id, operationId: 'late-create', placementOperationId: 'late-move', satisfiedTaskTypes: ['classify.root' as const],
        resultDigests: [placementResultDigest(f.folder)], inputDigest: placementInputDigest(pins, { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] }) };
      const receipt = await device.execute(auth, p => p.accept(input));
      expect(receipt.state).toBe('accepted');
      const updated = await f.uow.execute(f.owner, p => getAutomationRun(p.runs, row.id));
      expect(updated.status).toBe('cancelled'); expect(updated.effects).toHaveLength(1);
      expect(BigInt(updated.revision)).toBeGreaterThan(BigInt(cancelled.revision));
      await device.execute(auth, p => p.accept({ ...input, localReceiptId: randomUUID() }));
      expect(await f.uow.execute(f.owner, p => getAutomationRun(p.runs, row.id))).toEqual(updated);
    } finally { await f.isolated.close(); }
  });
});
