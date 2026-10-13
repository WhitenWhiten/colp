import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationDigest, compilePredicate, validateAutomation } from '@know-n/colp/automation';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { setPause } from '../../../src/modules/automation/index.js';
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
});
