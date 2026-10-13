import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { up as upgradeEpoch, down as removeEpoch } from '../../../migrations/202610300900_automation_configuration_epoch.js';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { createRule, saveBinding, previewRule, setLifecycle, placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';
import type { RuleDefinition } from '@know-n/colp/automation';
describeWithPostgres('review: device receipt semantic authority', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  beforeEach(async () => { f = await automationDeviceFixture('receipt_review'); });
  afterEach(async () => { await f?.isolated.close(); });
  const device = () => createAutomationDeviceUnitOfWork(f.db, 'server');
  const auth = () => ({ credential: f.http.credential, sessionId: f.sessionId, origin: AUTOMATION_DEVICE_ORIGIN });
  async function addRule(definition: RuleDefinition, values = f.values) {
    return f.uow.execute(f.owner, async p => {
      const binding = await saveBinding(p, f.owner, { name: 'Reviewed rule bindings', values });
      const input = { definition, bindingSetId: binding.id }, rule = await createRule(p, f.owner, input);
      const preview = await previewRule(p, f.owner, { rule: input, mode: 'currentState' });
      await setLifecycle(p, f.owner, rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Review fixture', activationPreviewId: preview.previewId }, `"${rule.revision}"`);
      return rule;
    });
  }
  async function claim(ruleId: string, bundleRevision: string) {
    await f.syncCreate('review-paper', 'review-create');
    const pins = { committedNode: { serverUuid: 'server', collectionId: 'collection', nodeId: 'review-paper' }, ruleRevision: '1', bindingRevision: '1' };
    return device().execute(auth(), p => p.accept({ ...pins, ruleId, bundleRevision, deviceId: f.replica.deviceId,
      replicaGeneration: Number(f.replica.leaseGeneration), localReceiptId: randomUUID(), operationId: 'review-create',
      satisfiedTaskTypes: ['classify.root'], resultDigests: [placementResultDigest(f.folder)],
      inputDigest: placementInputDigest(pins, { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] }) }));
  }
  test('a matching URL outside the configured source folder cannot satisfy intake', async () => {
    const definition: RuleDefinition = { ...f.rule.definition, scope: { folderRole: 'source', includeDescendants: false },
      roles: [...f.rule.definition.roles, { key: 'source', kind: 'folder', required: true, description: '' }] };
    const scoped = await addRule(definition, { ...f.values, source: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } });
    const bundle = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    const receipt = await claim(scoped.id, bundle.revision);
    expect(receipt.state).toBe('review'); expect(receipt.satisfiedTaskTypes).toEqual([]);
  });
  test('equal-priority incompatible rules cannot be bypassed by a device choosing one destination', async () => {
    await addRule(f.rule.definition, { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } });
    const bundle = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    const receipt = await claim(f.rule.id, bundle.revision);
    expect(receipt.state).toBe('review'); expect(receipt.satisfiedTaskTypes).toEqual([]);
  });
  test('configuration changes advance bundle settings sequence without changing the Pause API revision', async () => {
    const first = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    await addRule({ ...f.rule.definition, name: 'Another rule', priority: 90 });
    const next = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    expect(next.settingsRevision).toBeGreaterThan(first.settingsRevision);
    expect(await f.uow.execute(f.owner, p => p.settings.get(f.owner.accountId))).toMatchObject({ revision: '0', paused: false });
  });
  test('configuration-epoch upgrade starts above previously issued settings sequences', async () => {
    await f.db.updateTable('automation_settings').set({ revision: '7' }).where('owner_id', '=', f.owner.accountId).execute();
    await sql`UPDATE automation_device_bundles SET settings_revision=99 WHERE owner_id=${f.owner.accountId}`.execute(f.db);
    // Isolated upgrade fixture: reproduce old runtime tables with issued bundle counters.
    await removeEpoch(f.db); await upgradeEpoch(f.db);
    const bundle = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    expect(bundle.settingsRevision).toBeGreaterThan(99);
  });
  test('deployment restore pause advances the authenticated snapshot sequence', async () => {
    const active = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    const pauseSql = readFileSync('../../deploy/restore.sh', 'utf8').split("<<'SQL'\n")[1]!.split('\nSQL')[0]!;
    await sql.raw(pauseSql).execute(f.db);
    const paused = await device().execute(auth(), p => p.bundle('browser-bounded-v1'));
    expect(paused.paused).toBe(true); expect(paused.rules).toEqual([]);
    expect(paused.settingsRevision).toBeGreaterThan(active.settingsRevision);
  });

});
