import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationJobFixture } from '../../support/automation-job-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { claimJob, submitResult, getAutomationRun, undoAutomationRun } from '../../../src/modules/automation/index.js';
import { writeAgentPolicy } from '../../../src/infrastructure/collections/index.js';
import { convergeOwnerWork } from '../../../src/infrastructure/automation/index.js';

describeWithPostgres('AW-25 plan history and conservative single-effect Undo', () => {
  let f: Awaited<ReturnType<typeof automationJobFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  async function finish(kind: 'summary' | 'tags' | 'move',crash = false) {
    f = await automationJobFixture('aw25_'+kind,kind,{ afterCanonicalCommit: async () => { if (crash) throw new Error('lost completion'); } });
    await writeAgentPolicy(f.db,f.owner.accountId,'client','trusted');
    const lease = await claimJob(f.leases,f.actor,f.jobId,{ deliveryHandle: 'handle' });
    const evidence = [{ kind: 'source',reference: f.inputs[0]!.sourceEventId,observedAt: new Date().toISOString() }];
    const output = kind === 'move' ? { kind: 'placement',decision: 'move',destination: f.folder,reason: 'Within pinned subtree',evidence }
      : kind === 'tags' ? { kind: 'tags',mergeMode: 'unionPreserveUser',add: [{ key: 'research',label: 'Research',evidence }] }
      : { kind: 'text',textType: 'summary',text: 'A deterministic summary',language: 'en',evidence };
    const submit = submitResult(f.results,f.actor,f.jobId,{ claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: f.task.outputContract,output });
    if (crash) await expect(submit).rejects.toThrow('lost completion'); else expect((await submit).status).toBe('succeeded');
  }
  const run = () => f.uow.execute(f.owner,p => getAutomationRun(p.runs,f.runId));
  test('one isolated plan move has version linkage and compensates only its verified placement', async () => {
    await finish('move'); const before = await run(), effect = before.effects[0]!;
    expect(effect).toMatchObject({ kind: 'plan',undoAvailable: true }); expect(effect.versionId).toBeTruthy();
    const unrelated = await f.db.selectFrom('nodes').select(['id','title','parent_id']).where('id','in',['parent','academic','paper']).orderBy('id').execute();
    const result = await f.uow.execute(f.owner,p => undoAutomationRun(p,f.runId,{ effectReceiptId: effect.id,expectedEffectDigest: effect.effectDigest,reason: 'Undo only this move' },`"${before.revision}"`));
    expect(result.status).toBe('completed');
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','job-paper').executeTakeFirstOrThrow()).parent_id).toBe('root');
    expect(await f.db.selectFrom('nodes').select(['id','title','parent_id']).where('id','in',['parent','academic','paper']).orderBy('id').execute()).toEqual(unrelated);
    expect((await run()).effects[0]).toMatchObject({ status: 'reverted',undoAvailable: false });
  });
  test.each(['summary','tags'] as const)('%s has a fenced compensation and does not restore an unrelated tree', async kind => {
    await finish(kind); const current = await run(), effect = current.effects[0]!;
    expect(effect.undoAvailable).toBe(true);
    await f.uow.execute(f.owner,p => undoAutomationRun(p,f.runId,{ effectReceiptId: effect.id,expectedEffectDigest: effect.effectDigest,reason: 'Undo this field' },`"${current.revision}"`));
    if (kind === 'summary') expect(await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').where('deleted_at','is',null).execute()).toHaveLength(0);
    else expect((await f.db.selectFrom('nodes').select('payload_json').where('id','=','job-paper').executeTakeFirstOrThrow()).payload_json?.tags).toEqual([]);
    expect((await run()).effects[0]).toMatchObject({ status: 'reverted', undoAvailable: false });
  });
  test.each(['summary','tags'] as const)('generic approval Undo compensates %s and replays without another mutation', async kind => {
    const { createPhase4bMcpAgentApprovalApi } = await import('../../../src/infrastructure/collections/index.js');
    const { randomUUID } = await import('node:crypto');
    await finish(kind); const effect = (await run()).effects[0]!;
    const { undoAutomationApproval } = await import('../../../src/infrastructure/automation/index.js');
    const api = createPhase4bMcpAgentApprovalApi(f.db, { undoAutomation: input => undoAutomationApproval(f.db, input) });
    const input = { accountId:f.owner.accountId,subjectId:f.owner.subjectId,planId:effect.planId!,force:false,commandId:randomUUID() };
    expect(await api.undo(input)).toMatchObject({ restored: true, noop: false });
    expect(await api.undo(input)).toMatchObject({ restored: true, noop: true });
    if (kind === 'summary') expect(await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').where('deleted_at','is',null).execute()).toHaveLength(0);
    else expect((await f.db.selectFrom('nodes').select('payload_json').where('id','=','job-paper').executeTakeFirstOrThrow()).payload_json?.tags).toEqual([]);
  });
  test.each(['move', 'summary', 'tags'] as const)('later unrelated content prevents %s Undo rather than restoring unrelated changes', async kind => {
    await finish(kind); await f.rename('paper','New user title');
    const current = await run(), effect = current.effects[0]!; expect(effect.undoAvailable).toBe(false);
    await expect(f.uow.execute(f.owner,p => undoAutomationRun(p,f.runId,{ effectReceiptId: effect.id,expectedEffectDigest: effect.effectDigest,reason: 'Unsafe' },`"${current.revision}"`))).rejects.toMatchObject({ code: 'automation_stale_input' });
    expect((await f.db.selectFrom('nodes').select('title').where('id','=','paper').executeTakeFirstOrThrow()).title).toBe('New user title');
  });
  test('the maintenance sweep recovers a committed effect after cancellation without executing again', async () => {
    await finish('summary',true);
    await sql`UPDATE automation_runs SET state='cancelled',revision=revision+1 WHERE id=${f.runId}`.execute(f.db);
    const before = (await sql<{ revision: string }>`SELECT revision::text FROM automation_runs WHERE id=${f.runId}`.execute(f.db)).rows[0]!.revision;
    // Reads only report; the worker maintenance sweep converges the lost completion.
    expect((await run()).effects).toHaveLength(0);
    await convergeOwnerWork(f.db,f.owner.accountId,'server');
    const current = await run(); expect(current.status).toBe('cancelled'); expect(current.effects).toHaveLength(1);
    expect(BigInt(current.revision)).toBe(BigInt(before)+1n);
    expect((await run()).revision).toBe(current.revision);
    expect(await f.db.selectFrom('annotations').select('id').where('subject_id','=','job-paper').execute()).toHaveLength(1);
  });
});
