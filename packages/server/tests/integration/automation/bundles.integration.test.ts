import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationDigest, compilePredicate, validateAutomation } from '@know-n/colp/automation';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RuleDefinition } from '@know-n/colp/automation';
import { setPause, createRule, saveBinding, previewRule, setLifecycle } from '../../../src/modules/automation/index.js';
import { createOwnedCollectionCanonical, createCollectionNode } from '../../../src/modules/collections/index.js';
describeWithPostgres('authenticated full M1 bundles', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  beforeEach(async () => { f = await automationDeviceFixture('aw18'); });
  afterEach(async () => { await f?.isolated.close(); });
  const request = () => ({ credential: f.http.credential, sessionId: f.sessionId, origin: AUTOMATION_DEVICE_ORIGIN });
  const uow = () => createAutomationDeviceUnitOfWork(f.db, 'server');
  test('full snapshot preserves the finite rule and digest, with bounded expiry and unsupported profiles rejected atomically', async () => {
    const bundle = await uow().execute(request(), p => p.bundle('browser-bounded-v1'));
    expect(validateAutomation('RuleBundle', bundle).valid).toBe(true);
    expect(bundle.rules[0]!.definition).toEqual(f.rule.definition);
    const { digest, ...content } = bundle; expect(digest).toBe(automationDigest(content));
    expect(Date.parse(bundle.expiresAt) - Date.parse(bundle.issuedAt)).toBe(604800000);
    expect(compilePredicate(bundle.rules[0]!.definition.match).valid).toBe(true);
    await expect(uow().execute(request(), p => p.bundle('javascript'))).rejects.toMatchObject({ code: 'automation_unsupported_capability' });
    expect((await sql<{ count: string }>`SELECT count(*) FROM automation_device_bundles`.execute(f.db)).rows[0]!.count).toBe('2');
    await sql`UPDATE automation_device_bundles SET expires_at=clock_timestamp()-interval '1 second' WHERE revision=2`.execute(f.db);
    await expect(uow().execute(request(), p => p.acknowledge({ deviceId: f.replica.deviceId, bundleRevision: '2', status: 'applied', diagnostics: [] })))
      .rejects.toMatchObject({ code: 'automation_stale_input' });
  });
  test('pause emits an atomic disabling snapshot and monotonic settings; resume regenerates the complete rule set', async () => {
    const previous = await uow().execute(request(), p => p.bundle('browser-bounded-v1'));
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: true, reason: 'Fixture pause' }, '"0"'));
    const paused = await uow().execute(request(), p => p.bundle('browser-bounded-v1'));
    expect(paused).toMatchObject({ paused: true, rules: [], removedRuleIds: [f.rule.id] });
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: false, reason: 'Fixture resume' }, '"1"'));
    const active = await uow().execute(request(), p => p.bundle('browser-bounded-v1'));
    expect(paused.settingsRevision).toBeGreaterThan(previous.settingsRevision);
    expect(active.settingsRevision).toBeGreaterThan(paused.settingsRevision); expect(active.rules).toHaveLength(1); expect(BigInt(active.revision)).toBeGreaterThan(BigInt(paused.revision));
  });
  test('an unsynced collection never blocks the bundle, and a worker intake rule delegates only its own collection', async () => {
    await f.canonical.execute(ports => createOwnedCollectionCanonical(ports, { actor: f.actor, command: f.command(), title: 'Other', summary: null,
      kind: 'bookmarks', collectionId: 'other', rootNodeId: 'other-root', operationId: 'other_operation' }));
    await f.canonical.execute(ports => createCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'other', parentId: 'other-root',
      intakeDisposition: 'userDefault', nodeId: 'other-folder', afterId: null, beforeId: null,
      node: { kind: 'folder', title: 'Other folder', description: null, tags: [], visibility: 'inherit' } }));
    const other = structuredClone(f.rule.definition); other.scope.collectionId = 'other';
    await f.uow.execute(f.owner, async ports => {
      const binding = await saveBinding(ports, f.owner, { name: 'Other folders', values: { academicRoot: { ...f.values.academicRoot,
        folder: { serverUuid: 'server', collectionId: 'other', nodeId: 'other-folder' } } } });
      const input = { definition: other, bindingSetId: binding.id };
      const rule = await createRule(ports, f.owner, input);
      const preview = await previewRule(ports, f.owner, { rule: input, mode: 'currentState' });
      await setLifecycle(ports, f.owner, rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Unsynced collection', activationPreviewId: preview.previewId }, `"${rule.revision}"`);
    });
    const synced = await uow().execute(request(), p => p.bundle('browser-bounded-v1'));
    expect(synced.rules.map(rule => rule.ruleId)).toEqual([f.rule.id]);
    // A worker intake rule needs server tasks after placement; the browser cannot run it exactly.
    const worker = JSON.parse(readFileSync(new URL('../../../../../docs/automation/design/examples/academic-summary-only.json', import.meta.url), 'utf8')) as RuleDefinition;
    await f.uow.execute(f.owner, async p => {
      const previous = (await p.rules.load(f.owner.accountId, f.rule.id))!;
      await p.rules.save(f.owner.accountId, { ...previous, definitionRevisionId: randomUUID(), definitionRevision: '2', view: { ...previous.view, revision: '3',
        definition: { ...previous.view.definition, roles: worker.roles, tasks: worker.tasks.slice(0, 1) } } });
    });
    const delegated = await uow().execute(request(), p => p.bundle('browser-bounded-v1'));
    expect(delegated).toMatchObject({ paused: false, rules: [], removedRuleIds: [f.rule.id] });
  });
});
