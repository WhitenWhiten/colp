import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { TargetPage } from '@know-n/colp/automation';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationPagination } from '../../../src/modules/automation/index.js';
import { automationWorkPrincipal,createAutomationToolPort,createMcpApplicationContext } from '../../../src/modules/mcp/index.js';

const cursorKey = 'worker-test-cursor-at-least-32-bytes';
describeWithPostgres('Worker inbox discovery pagination',() => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });

  async function context(token = f.token) {
    const v = await f.verifier.verify({ authorization: 'Bearer '+token });
    return createMcpApplicationContext({ principal: v.binding,scopes: v.scopes,abortSignal: new AbortController().signal,
      budgets: { maxDepth: 16,maxNodes: 1000,maxBytes: 100000,maxOperations: 100 },correlationId: randomUUID(),
      authorization: { accountSubjectId: v.accountSubjectId,automationCredential: { connectionId: v.automationConnectionId,
        credentialDigest: v.credentialDigest,expiresAt: v.expiresAt.toISOString(),issuedAtSeconds: v.issuedAtSeconds,accountSecurityEpoch: v.accountSecurityEpoch } } });
  }

  test('MCP pages all own paired inboxes, preserves timestamp precision and rejects unrelated cursors',async () => {
    f = await automationWorkerFixture('worker_inbox_pages');
    const setup = await f.setup();
    expect((await f.pair(setup.grant)).statusCode).toBe(200);
    // More than one maximum-size page, including equal timestamps and sub-millisecond differences.
    const expected = Array.from({ length: 102 },(_,index) => `inbox-${String(index).padStart(3,'0')}`);
    await sql`INSERT INTO automation_targets(id,owner_id,profile_id,configuration_json,paired,created_at)
      SELECT 'inbox-'||lpad(n::text,3,'0'),${f.owner.accountId},${setup.profile.id},${JSON.stringify(setup.target.configuration)}::jsonb,true,
        '2026-01-01T00:00:00Z'::timestamptz+(n/2)*interval '1 microsecond'
      FROM generate_series(0,101) n`.execute(f.db);
    expected.push(setup.target.id);
    // Same profile but unpaired/revoked, another credential of this client, and another owner are all excluded.
    await sql`INSERT INTO automation_targets(id,owner_id,profile_id,configuration_json,paired,revoked)
      VALUES('unpaired',${f.owner.accountId},${setup.profile.id},${JSON.stringify(setup.target.configuration)}::jsonb,false,false),
        ('revoked',${f.owner.accountId},${setup.profile.id},${JSON.stringify(setup.target.configuration)}::jsonb,true,true)`.execute(f.db);
    const otherToken = await f.mint({ scopes: ['automation:work','mcp:read:own'] }),otherContext = await context(otherToken),otherActor = automationWorkPrincipal(otherContext);
    const otherProfile = await f.ownerPost('/connection-profiles',{ ...setup.profile.configuration,credentialBindingId: otherActor.credentialBindingId });
    expect(otherProfile.statusCode,otherProfile.body).toBe(201);
    const anotherOwner = await f.issue('other');
    await sql`INSERT INTO automation_connection_profiles(id,owner_id,configuration_json)
      VALUES('foreign-profile',${anotherOwner.accountId},${JSON.stringify(setup.profile.configuration)}::jsonb)`.execute(f.db);
    for (const [id,ownerId,profileId] of [['other-credential',f.owner.accountId,otherProfile.json().id],['other-owner',anotherOwner.accountId,'foreign-profile']]) {
      await sql`INSERT INTO automation_targets(id,owner_id,profile_id,configuration_json,paired)
        VALUES(${id},${ownerId},${profileId},${JSON.stringify({ ...setup.target.configuration,connectionProfileId: profileId })}::jsonb,true)`.execute(f.db);
    }
    const port = createAutomationToolPort({ access: c => f.worker.access(automationWorkPrincipal(c)),configurations: f.uow,pairing: f.worker,cursorKey });
    const c = await context();
    const page = async (args: Record<string,unknown> = {}) => {
      const result = await port.call(c,'automation.targets.mine',args);
      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') throw new Error('Inbox page rejected');
      return result.structuredContent as TargetPage;
    };
    const first = await page({ limit: 1 });
    expect(first.items.map(item => item.id)).toEqual(expected.slice(0,1));
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page({ limit: 1,cursor: first.nextCursor });
    expect(second.items.map(item => item.id)).toEqual(expected.slice(1,2));
    const third = await page({ limit: 1,cursor: second.nextCursor });
    expect(third.items.map(item => item.id)).toEqual(expected.slice(2,3));
    const fourth = await page({ limit: 1,cursor: third.nextCursor });
    expect(fourth.items.map(item => item.id)).toEqual(expected.slice(3,4));
    expect((await page()).items).toHaveLength(50);
    const large = await page({ limit: 100 });
    expect(large.items).toHaveLength(100);
    const tail = await page({ limit: 100,cursor: large.nextCursor });
    expect(tail.nextCursor).toBeNull();
    expect([...large.items,...tail.items].map(item => item.id)).toEqual(expected);
    for (const args of [{ limit: 2,cursor: first.nextCursor },{ limit: 1,cursor: first.nextCursor+'tampered' }]) {
      expect(await port.call(c,'automation.targets.mine',args)).toMatchObject({ kind: 'rejected',stableCode: 'invalid_cursor' });
    }
    expect(await port.call(otherContext,'automation.targets.mine',{ limit: 1,cursor: first.nextCursor })).toMatchObject({ kind: 'rejected',stableCode: 'invalid_cursor' });
    const identity = JSON.stringify([f.actor.accountId,f.actor.clientId,f.actor.credentialBindingId]),now = new Date();
    const wrongScope = createAutomationPagination(cursorKey).next(identity,'targets',1,{ id: expected[0]!,createdAt: now.toISOString() },now);
    expect(await port.call(c,'automation.targets.mine',{ limit: 1,cursor: wrongScope })).toMatchObject({ kind: 'rejected',stableCode: 'invalid_cursor' });
    await f.revocations.revokeClient(f.actor.clientId);
    expect(await port.call(c,'automation.targets.mine',{ limit: 1,cursor: first.nextCursor })).toMatchObject({ kind: 'rejected',stableCode: 'resource_not_found' });
  });
});
