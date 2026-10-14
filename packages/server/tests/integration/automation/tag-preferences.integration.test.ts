import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Lease } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('Explicit Owner negative tag preferences', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('closed Owner command normalizes keys, replays once, suppresses output and can be reversed', async () => {
    f = await automationPollingFixture('tag_preferences', { configure: d => {
      d.tasks[0]!.type = 'tags.generate'; d.tasks[0]!.outputContract = 'tags.sourced.v1';
    } });
    const url = `/api/v1/me/automations/rules/${f.rule.id}/rejected-tags/${encodeURIComponent('e\u0301')}`;
    const command = randomUUID();
    const reject = () => f.app.inject({ method:'POST',url,headers:f.ownerHeaders(command,`"${f.rule.revision}"`),payload:{reason:'Do not suggest this tag'} });
    const rejected = await reject();expect(rejected.statusCode,rejected.body).toBe(200);
    expect((await reject()).body).toBe(rejected.body);
    expect((await sql<{tag_key:string}>`SELECT tag_key FROM automation_tag_rejections`.execute(f.db)).rows).toEqual([{tag_key:'é'}]);
    async function submit() {
      const job=(await f.work!.list(f.actor,{targetId:f.target.id})).items[0]!;
      const inputs=await f.work!.inputs(f.actor,job.id,{deliveryHandle:job.deliveryHandle!});
      const lease=await f.work!.mutate(f.actor,job.id,'claim',{deliveryHandle:job.deliveryHandle},randomUUID()) as Lease;
      return f.work!.mutate(f.actor,job.id,'submit',{claimToken:lease.claimToken,generation:lease.generation,inputDigest:lease.inputDigest,outputContract:job.task.outputContract,
        output:{kind:'tags',mergeMode:'unionPreserveUser',add:[{key:'é',label:'é',evidence:[{kind:'source',reference:inputs.items[0]!.sourceEventId,observedAt:new Date().toISOString()}]}]}},randomUUID());
    }
    const previousTags=(await f.db.selectFrom('nodes').select('tags').where('id','=','fresh-paper').executeTakeFirstOrThrow()).tags;
    expect(await submit()).toMatchObject({status:'succeeded',effectReceiptIds:[]});
    expect((await f.db.selectFrom('nodes').select('tags').where('id','=','fresh-paper').executeTakeFirstOrThrow()).tags).toEqual(previousTags);
    const allowed=await f.app.inject({method:'DELETE',url,headers:f.ownerHeaders(undefined,String(rejected.headers.etag)),payload:{reason:'Allow suggestions again'}});
    expect(allowed.statusCode,allowed.body).toBe(200);
    await f.createNode('allowed-tag','root','Allowed','https://arxiv.org/allowed');await f.inspect();
    expect(await submit()).toMatchObject({status:'succeeded'});
    expect((await f.db.selectFrom('nodes').select('tags').where('id','=','allowed-tag').executeTakeFirstOrThrow()).tags).toEqual(['é']);
  });
});
