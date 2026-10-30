import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationManagerFixture } from '../../support/automation-manager-fixture.js';
import type { ConnectionProfile, Target } from '@know-n/colp/automation';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { saveConnectionProfile } from '../../../src/modules/automation/index.js';

describeWithPostgres('MCP automation manager configuration', () => {
  let f: Awaited<ReturnType<typeof automationManagerFixture>>;
  beforeAll(async () => { f = await automationManagerFixture('mcp_manager_configuration'); });
  afterAll(async () => { await f?.isolated.close(); });
  test('global pause uses the observed revision and exact command receipts', async () => {
    const before = await f.call('automation.pause.get'); expect(before.kind).toBe('complete');
    if (before.kind !== 'complete') throw Error('Pause read failed');
    const state = before.structuredContent as { paused: boolean; revision: string };
    const args = { commandId: randomUUID(), baseRevision: state.revision, change: { paused: true, reason: 'Pause from manager' } };
    const paused = await f.call('automation.pause.set', args);
    expect(paused).toMatchObject({ kind: 'complete', structuredContent: { paused: true } });
    if (paused.kind !== 'complete') throw Error('Pause mutation failed');
    expect(await f.call('automation.pause.set', args)).toEqual(paused);
    expect(await f.call('automation.pause.set', { ...args, commandId: randomUUID(), change: { paused: false } }))
      .toMatchObject({ kind: 'rejected', stableCode: 'precondition_failed' });
    const revision = (paused.structuredContent as { revision: string }).revision;
    expect(await f.call('automation.pause.set', { commandId: randomUUID(), baseRevision: revision, change: { paused: false } }))
      .toMatchObject({ kind: 'complete', structuredContent: { paused: false } });
    expect(await f.api.callTool({ ...f.context, scopes: ['automation:read'] }, 'automation.pause.set', args))
      .toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
  });

  test('manager creates, pages and updates profiles and targets with owner and revision isolation', async () => {
    const configuration = { name: 'Research agent', automationEnabled: true, catalogs: ['automationWorker'],
      authorizedClientId: 'research-agent', credentialBindingId: 'research-binding' };
    const create = { mode: 'create', commandId: randomUUID(), configuration };
    const profile = await f.value<ConnectionProfile>('automation.connection_profiles.save', create);
    expect(await f.value('automation.connection_profiles.save', create)).toEqual(profile);
    expect(await f.call('automation.connection_profiles.save', { ...create, configuration: { ...configuration, name: 'Changed replay' } }))
      .toMatchObject({ kind: 'rejected', stableCode: 'automation_command_conflict' });
    for (let n = 0; n < 2; n++) await f.value('automation.connection_profiles.save', { ...create, commandId: randomUUID(),
      configuration: { ...configuration, credentialBindingId: `other-${n}` } });
    const first = await f.value<{ items: ConnectionProfile[]; nextCursor: string }>('automation.connection_profiles.list', { limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next = await f.value<{ items: ConnectionProfile[] }>('automation.connection_profiles.list', { cursor: first.nextCursor });
    expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
    const update = { mode: 'update', commandId: randomUUID(), profileId: profile.id, baseRevision: profile.revision,
      configuration: { ...configuration, name: 'Renamed agent' } };
    const renamed = await f.value<ConnectionProfile>('automation.connection_profiles.save', update);
    expect(renamed.configuration.name).toBe('Renamed agent');
    expect(await f.call('automation.connection_profiles.save', { ...update, commandId: randomUUID() }))
      .toMatchObject({ kind: 'rejected', stableCode: 'precondition_failed' });
    const other = await f.issue('foreign-configuration-owner');
    const privateProfile = await createAutomationUnitOfWork(f.db, 'server').execute(other, ports => saveConnectionProfile(ports.targets,
      { ...configuration, credentialBindingId: 'foreign-binding' }));
    expect(await f.call('automation.connection_profiles.get', { profileId: privateProfile.id }))
      .toMatchObject({ kind: 'rejected', stableCode: 'resource_not_found' });
    const target = await f.value<Target>('automation.targets.save', { mode: 'create', commandId: randomUUID(), configuration: {
      name: 'Research inbox', providerLabel: 'Agent', broadcastOptIn: false, privacy: 'standard', connectionProfileId: profile.id,
      wakeMode: 'poll', pollIntervalMinutes: 5 } });
    expect(await f.value('automation.targets.get', { targetId: target.id })).toEqual(target);
    expect(await f.value('automation.targets.revoke', { targetId: target.id, baseRevision: target.revision,
      commandId: randomUUID(), reason: 'Retire test inbox' })).toMatchObject({ status: 'revoked' });
    expect(await f.api.callTool({ ...f.context, scopes: ['automation:read'] }, 'automation.targets.save', { mode: 'create', commandId: randomUUID(), configuration: {} }))
      .toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
  });
});
