import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import type { LocalReceiptInput } from '@know-n/colp/automation';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { acceptIntakeReceipt, placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';

describeWithPostgres('canonical browser intake roots', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  beforeEach(async () => { f = await automationDeviceFixture('intake-roots'); });
  afterEach(async () => { await f?.isolated.close(); });

  async function verify(parentId: string) {
    const created = await f.syncCreate('observed', 'observed-create', parentId);
    expect(created.results[0]!.status).toBe('applied');
    const moved = await f.syncMove('observed', 'observed-move');
    expect(moved.results[0]!.status).toBe('applied');
    const identity = { committedNode: { ...f.folder, nodeId: 'observed' }, ruleRevision: '1', bindingRevision: '1' };
    const input: LocalReceiptInput = { ...identity, deviceId: f.replica.deviceId, replicaGeneration: Number(f.replica.leaseGeneration),
      localReceiptId: randomUUID(), operationId: 'observed-create', placementOperationId: 'observed-move',
      ruleId: f.rule.id, bundleRevision: '1', beforeFolder: { ...f.folder, nodeId: parentId },
      inputDigest: placementInputDigest(identity, { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] }),
      resultDigests: [placementResultDigest(f.folder)], satisfiedTaskTypes: ['classify.root'] };
    const accept = () => createAutomationDeviceUnitOfWork(f.db, 'server').execute({ credential: f.http.credential,
      sessionId: f.sessionId, origin: AUTOMATION_DEVICE_ORIGIN }, ports => acceptIntakeReceipt(ports, input));
    return { result: await accept(), accept };
  }

  test.each(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks'] as const)(
    'observed create then move from %s accepts only the proven canonical effect', async folderRole => {
      await f.syncCreateNode('browser-root', 'browser-root-create', 'root', {
        kind: 'folder', folderRole, title: 'Browser root', visibility: 'inherit', extensions: {},
      });
      const { result, accept } = await verify('browser-root');
      expect(result).toMatchObject({ state: 'accepted', satisfiedTaskTypes: ['classify.root'] });
      await f.inspect();
      expect(await accept()).toEqual(result);
      const effects = (await sql`SELECT operation_id FROM automation_effect_receipts`.execute(f.db)).rows;
      expect(effects).toEqual([{ operation_id: 'observed-move' }]);
    },
  );

  test('a canonical move from an ordinary selected folder does not establish root satisfaction', async () => {
    const { result } = await verify('parent');
    expect(result).toMatchObject({ state: 'review', satisfiedTaskTypes: [] });
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
  });
});
