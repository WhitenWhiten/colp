import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationJobFixture } from '../../support/automation-job-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { claimJob, submitResult } from '../../../src/modules/automation/index.js';
import { writeAgentPolicy, createPhase4bMcpAgentApprovalApi } from '../../../src/infrastructure/collections/index.js';

describeWithPostgres('AW-24 typed proposal and real plan recovery', () => {
  let f: Awaited<ReturnType<typeof automationJobFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  const evidence = () => [{ kind: 'source' as const,reference: f.inputs[0]!.sourceEventId,observedAt: new Date().toISOString() }];
  async function input() {
    const lease = await claimJob(f.leases,f.actor,f.jobId,{ deliveryHandle: 'handle' });
    return { claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: f.task.outputContract,
      output: { kind: 'text' as const,textType: 'summary' as const,text: 'Deterministic injected summary',language: 'en',evidence: evidence() } };
  }
  test('manual result appears in existing Approvals, commits once, then repeated submit has one effect', async () => {
    f = await automationJobFixture('aw24_manual'); const body = await input();
    const pending = await submitResult(f.results,f.actor,f.jobId,body); expect(pending.status).toBe('awaitingApproval');
    const api = createPhase4bMcpAgentApprovalApi(f.db), page = await api.list({ id: f.owner.accountId });
    expect(page.items).toHaveLength(1); const plan = page.items[0]!;
    const { randomUUID } = await import('node:crypto');
    await api.decide({ account: { id: f.owner.accountId },planId: plan.planId,decision: 'approve',commandId: randomUUID(),commandScope: 'test-approval',fingerprint: 'approved',ifMatch: plan.etag });
    const accepted = await submitResult(f.results,f.actor,f.jobId,body); expect(accepted.status).toBe('succeeded');
    expect((await submitResult(f.results,f.actor,f.jobId,body)).effectReceiptIds).toEqual(accepted.effectReceiptIds);
    expect((await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').execute())).toHaveLength(1);
    expect((await sql`SELECT * FROM automation_effect_receipts WHERE job_id=${f.jobId}`.execute(f.db)).rows).toHaveLength(1);
  });
  test('trusted canonical commit followed by crash recovers same plan, note and receipt', async () => {
    let crash = true;
    f = await automationJobFixture('aw24_crash','summary',{ afterCanonicalCommit: async () => { if (crash) throw new Error('crash after canonical commit'); } });
    await writeAgentPolicy(f.db,f.owner.accountId,'client','trusted'); const body = await input();
    await expect(submitResult(f.results,f.actor,f.jobId,body)).rejects.toThrow('crash after canonical commit');
    expect((await sql`SELECT * FROM automation_effect_receipts WHERE job_id=${f.jobId}`.execute(f.db)).rows).toHaveLength(0);
    expect((await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').execute())).toHaveLength(1);
    crash = false;
    expect((await submitResult(f.results,f.actor,f.jobId,body)).status).toBe('succeeded');
    expect((await f.db.selectFrom('mcp_change_plans').select('plan_id').execute())).toHaveLength(1);
    expect((await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').execute())).toHaveLength(1);
  });
  test('crash before canonical commit retains the proposal and same plan for retry', async () => {
    let crash = true;
    f = await automationJobFixture('aw24_before','summary',{ beforeCanonicalCommit: async () => { if (crash) throw new Error('crash before canonical commit'); } });
    await writeAgentPolicy(f.db,f.owner.accountId,'client','trusted'); const body = await input();
    await expect(submitResult(f.results,f.actor,f.jobId,body)).rejects.toThrow();
    expect(await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').execute()).toHaveLength(0);
    const before = await f.db.selectFrom('mcp_change_plans').select('plan_id').execute(); expect(before).toHaveLength(1);
    crash = false;
    expect((await submitResult(f.results,f.actor,f.jobId,body)).status).toBe('succeeded');
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toEqual(before);
  });
  test('summary appends attribution to the existing note without replacing user text', async () => {
    f = await automationJobFixture('aw24_append');
    const { createPostgresAnnotationMutationUnitOfWork } = await import('../../../src/infrastructure/collections/index.js');
    const { createAnnotation } = await import('../../../src/modules/collections/index.js');
    await createPostgresAnnotationMutationUnitOfWork(f.db).execute(p => createAnnotation(p,{ actor: { principalId: f.owner.accountId,subjectId: f.owner.subjectId,principalType: 'account',creator: { id: 'urn:colp:owner',name: 'Owner' } },
      command: f.command(),collectionId: 'collection',annotationId: 'owner-note',annotation: { type: 'note',subject: { type: 'node',id: 'job-paper' },format: 'plain',value: 'Preserve my text.',visibility: 'private' } }));
    await writeAgentPolicy(f.db,f.owner.accountId,'client','trusted');
    expect((await submitResult(f.results,f.actor,f.jobId,await input())).status).toBe('succeeded');
    const notes = await f.db.selectFrom('annotations').select('payload_json').where('subject_id','=','job-paper').execute();
    expect(notes).toHaveLength(1); expect(notes[0]!.payload_json.value).toContain('Preserve my text.');
    expect(notes[0]!.payload_json.value).toContain('Deterministic injected summary');
  });
  test.each(['tags','move'] as const)('trusted %s follows canonical plan and version path', async kind => {
    f = await automationJobFixture('aw24_'+kind,kind); await writeAgentPolicy(f.db,f.owner.accountId,'client','trusted');
    const body = await input();
    const output = kind === 'tags' ? { kind: 'tags',mergeMode: 'unionPreserveUser',add: [{ key: 'research',label: 'Research',evidence: evidence() }] }
      : { kind: 'placement',decision: 'move',destination: f.folder,reason: 'Pinned subtree',evidence: evidence() };
    const result = await submitResult(f.results,f.actor,f.jobId,{ ...body,output }); expect(result.status).toBe('succeeded');
    expect((await sql`SELECT * FROM mcp_plan_commit_revisions`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT * FROM automation_effect_receipts WHERE job_id=${f.jobId}`.execute(f.db)).rows).toHaveLength(1);
    const node = await f.db.selectFrom('nodes').select(['parent_id','payload_json']).where('id','=','job-paper').executeTakeFirstOrThrow();
    if (kind === 'tags') expect(node.payload_json?.tags).toEqual(['research']); else expect(node.parent_id).toBe('academic');
  });
  test('wrong type/source/contract and newer manual edit cannot create plans or effects', async () => {
    f = await automationJobFixture('aw24_negative'); const body = await input();
    await expect(submitResult(f.results,f.actor,f.jobId,{ ...body,outputContract: 'review.sourced.v1' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(submitResult(f.results,f.actor,f.jobId,{ ...body,output: { ...body.output,evidence: [{ ...evidence()[0],reference: 'foreign' }] } })).rejects.toMatchObject({ code: 'invalid_request' });
    await f.rename('job-paper','User edit');
    await expect(submitResult(f.results,f.actor,f.jobId,body)).rejects.toMatchObject({ code: 'automation_stale_input' });
    expect((await f.db.selectFrom('mcp_change_plans').select('plan_id').execute())).toHaveLength(0);
  });
});
