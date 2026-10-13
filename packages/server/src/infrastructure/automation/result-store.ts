import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { type TaskSpec, type TaskInput, type FolderRef, type SubmissionResult } from '@know-n/colp/automation';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import { AutomationError, assessTypedEffect, type ResultSubmissionPort, type WorkPrincipal } from '../../modules/automation/index.js';
import type { AutomationPlanOperation } from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockWorkJob, type TargetAuthority } from './work-authority.js';
import { claimTokenHash, workBinding, requireJobLease } from './lease-store.js';
import { createBindingReadPort } from './bindings.js';
import type { PinnedProposal, ProposalPlanGateway } from './proposal-plan-gateway.js';

interface ResultRow { id: string; proposal_digest: string; status: string }
export function createResultSubmissionPort(db: Kysely<DatabaseSchema>,serverUuid: string,authorize: TargetAuthority,gateway: ProposalPlanGateway,
  options: { afterCanonicalCommit?: () => Promise<void> } = {}): ResultSubmissionPort & { guard(tx: DatabaseTransaction,planId: string): Promise<void> } {
  const proposal = async (tx: Kysely<DatabaseSchema>,jobId: string) => (await sql<PinnedProposal>`SELECT * FROM automation_proposals WHERE job_id=${jobId}`.execute(tx)).rows[0];
  async function currentInputs(tx: DatabaseTransaction,actor: WorkPrincipal,jobId: string) {
    const job = await lockWorkJob(tx,actor,jobId,authorize);
    const pin = (await sql<{ task_json: TaskSpec; input_json: TaskInput[]; allowed_folders: FolderRef[]; authority_digest: string }>`SELECT task_json,input_json,allowed_folders,authority_digest
      FROM automation_jobs WHERE id=${jobId}`.execute(tx)).rows[0]!;
    const node = await tx.selectFrom('nodes').select(['resource_revision','parent_id','payload_json','deleted_at']).where('id','=',job.node_id).where('collection_id','=',job.collection_id).executeTakeFirst();
    if (!node || node.deleted_at || node.resource_revision !== job.input_revision) throw new AutomationError('automation_stale_input','A canonical edit invalidated the pinned job input.');
    const reads = createBindingReadPort(tx,serverUuid);
    for (const folder of pin.allowed_folders) {
      const current = await reads.readFolder(actor,folder);
      if (current.status !== 'valid') throw new AutomationError('automation_binding_unavailable','Pinned folder authority is no longer available.');
    }
    return { job,pin,node };
  }
  return {
    async task(actor,id) {
      const row = (await sql<{ task_json: TaskSpec; target_id: string; input_json: TaskInput[] }>`SELECT j.task_json,j.target_id,j.input_json FROM automation_jobs j
        JOIN automation_runs r ON r.id=j.run_id WHERE j.id=${id} AND r.owner_id=${actor.accountId}`.execute(db)).rows[0];
      if (!row?.task_json) throw new AutomationError('resource_not_found','Job is unavailable.');
      await db.transaction().execute(tx => authorize(tx,actor,row.target_id));
      return { task: row.task_json,sourceReferences: row.input_json.map(input => input.sourceEventId) };
    },
    prepare: (actor,id,input,digest) => db.transaction().execute(async tx => {
      const job = await lockWorkJob(tx,actor,id,authorize);
      const existing = (await sql<ResultRow>`SELECT * FROM automation_results WHERE job_id=${id}`.execute(tx)).rows[0];
      if (existing) {
        const attempt = (await sql<{ claim_token_hash: string; principal_binding: string }>`SELECT claim_token_hash,principal_binding FROM automation_job_attempts
          WHERE job_id=${id} AND generation=${input.generation}`.execute(tx)).rows[0];
        if (!attempt || attempt.principal_binding !== workBinding(actor) || attempt.claim_token_hash !== claimTokenHash(input.claimToken)
          || String(job.active_generation) !== String(input.generation)) throw new AutomationError('automation_lease_lost','Submission belongs to another claim.');
        if (existing.proposal_digest !== digest) throw new AutomationError('automation_command_conflict','A different proposal already owns this job/input.');
        return;
      }
      await requireJobLease(tx,actor,job,input);
      const { pin,node } = await currentInputs(tx,actor,id);
      if (input.inputDigest !== job.input_digest) throw new AutomationError('automation_stale_input','Input digest changed.');
      const kind = assessTypedEffect(input.output,pin.allowed_folders), resultId = randomUUID();
      const policy = (await sql<{ configuration_json: { allowAutomaticWrites: boolean } }>`SELECT p.configuration_json FROM automation_runs r
        JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
        JOIN automation_execution_policy_revisions p ON p.policy_id=v.execution_policy_id AND p.revision::text=r.policy_revision
        WHERE r.id=${job.run_id}`.execute(tx)).rows[0];
      if (!policy) throw new AutomationError('automation_unsupported_capability','Pinned execution policy is unavailable.');
      const state = kind === 'review' ? 'review' : kind === 'none' ? 'succeeded' : 'committing';
      await sql`INSERT INTO automation_results(id,job_id,generation,owner_id,input_digest,contract_id,authority_digest,output_json,proposal_digest,status)
        VALUES(${resultId},${id},${input.generation},${actor.accountId},${input.inputDigest},${input.outputContract},${pin.authority_digest},${JSON.stringify(input.output)}::jsonb,${digest},${state==='succeeded' ? 'accepted' : 'proposed'})`.execute(tx);
      await sql`UPDATE automation_jobs SET state=${state},result_id=${resultId},revision=revision+1 WHERE id=${id}`.execute(tx);
      await sql`UPDATE automation_job_attempts SET outcome='submitted',provider_request_ref=${input.providerRequestId ?? null} WHERE job_id=${id} AND generation=${input.generation}`.execute(tx);
      if (kind === 'none' || kind === 'review') return;
      if (!actor.resourceAudience || !actor.securityEpoch) throw new AutomationError('insufficient_permission','Verified credential binding is required.');
      const planId = `automation-${id}`, commandId = randomUUID(), operationId = `automation-op-${id}`;
      const binding: McpAuthenticatedAuthorizationBinding = { kind: 'authenticated',principalId: actor.accountId,clientId: actor.clientId,
        credentialBindingId: actor.credentialBindingId,resourceAudience: actor.resourceAudience,securityEpoch: actor.securityEpoch };
      const operation: AutomationPlanOperation = { type: kind === 'tags' ? 'update_node' : kind === 'move' ? 'move_node' : 'create_annotation',
        collectionId: job.collection_id,nodeId: job.node_id,ruleId: job.rule_id,jobId: id,runId: job.run_id,commandId,operationId };
      const collection = await tx.selectFrom('collections').select(['content_revision','policy_revision']).where('id','=',job.collection_id).executeTakeFirstOrThrow();
      const revisions: Record<string,string> = { ['content.'+job.collection_id]: collection.content_revision,['policy.'+job.collection_id]: collection.policy_revision,['node.'+job.node_id]: node.resource_revision };
      if (input.output.kind === 'tags') {
        const rejected = new Set((await sql<{ tag_key: string }>`SELECT tag_key FROM automation_tag_rejections WHERE owner_id=${actor.accountId} AND rule_id=${job.rule_id}`.execute(tx)).rows.map(r => r.tag_key));
        operation.tags = [...new Set([...(node.payload_json?.tags as string[] ?? []),...input.output.add.map(tag => tag.key.normalize('NFC')).filter(tag => !rejected.has(tag))])];
      }
      if (input.output.kind === 'placement' && input.output.destination) {
        operation.parentId = input.output.destination.nodeId; operation.sourceParentId = node.parent_id!;
        for (const parentId of new Set([operation.parentId,operation.sourceParentId])) {
          const parent = await tx.selectFrom('nodes').select('children_revision').where('id','=',parentId).where('collection_id','=',job.collection_id).where('deleted_at','is',null).executeTakeFirstOrThrow();
          revisions['children.'+parentId] = parent.children_revision;
        }
      }
      if (input.output.kind === 'text') {
        operation.annotationId = `automation-note-${id}`;
        operation.text = `${input.output.text}\n\nAutomation ${job.rule_id} / ${id}${input.modelLabel ? ` (${input.modelLabel})` : ''}`;
        const existingNote = await tx.selectFrom('annotations').select(['id','resource_revision','payload_json'])
          .where('collection_id','=',job.collection_id).where('subject_id','=',job.node_id).where('subject_type','=','node')
          .where('creator_principal_id','=',actor.accountId).where('visibility','=','private').where('deleted_at','is',null)
          .where(sql<string>`payload_json->>'type'`,'=','note').orderBy('id').limit(2).execute();
        if (existingNote.length > 1) throw new AutomationError('automation_unsupported_capability','Multiple notes require explicit review; no arbitrary note is selected.');
        if (existingNote[0]) {
          const note = existingNote[0], payload = note.payload_json;
          if (typeof payload.value !== 'string' || !['plain','markdown'].includes(String(payload.format)))
            throw new AutomationError('automation_unsupported_capability','This note format cannot be safely appended.');
          operation.type='update_annotation';operation.annotationId=note.id;operation.annotationRevision=note.resource_revision;
          operation.text=payload.value+'\n\n'+operation.text;
          if (Buffer.byteLength(operation.text,'utf8')>65_536) throw new AutomationError('payload_too_large','Appended note exceeds the canonical note size bound.');
        }
        operation.creator = { id: `urn:colp:account:${actor.accountId}`,name: 'Automation' };
      }
      await sql`INSERT INTO automation_proposals(job_id,result_id,plan_id,command_id,binding_json,operations_json,base_revisions_json,allow_automatic_writes)
        VALUES(${id},${resultId},${planId},${commandId},${JSON.stringify(binding)}::jsonb,${JSON.stringify([operation])}::jsonb,${JSON.stringify(revisions)}::jsonb,${policy.configuration_json.allowAutomaticWrites})`.execute(tx);
    }),
    async reconcile(actor,id) {
      // Authorization is checked before attempting new effects; a committed plan is only linked, never reexecuted.
      const p = await proposal(db,id);
      let advanced: Awaited<ReturnType<ProposalPlanGateway['advance']>> | undefined;
      if (p) {
        const consumed = (await sql<{ status: string }>`SELECT status FROM mcp_change_plans WHERE plan_id=${p.plan_id}`.execute(db)).rows[0]?.status === 'consumed';
        if (!consumed) await db.transaction().execute(tx => currentInputs(tx,actor,id));
        advanced = consumed ? 'committed' : await gateway.advance(actor,p);
        if (advanced === 'committed') await options.afterCanonicalCommit?.();
      }
      return db.transaction().execute(async tx => {
        const job = await lockWorkJob(tx,actor,id,authorize), result = (await sql<ResultRow>`SELECT * FROM automation_results WHERE job_id=${id}`.execute(tx)).rows[0];
        if (!result) throw new AutomationError('resource_not_found','Result is unavailable.');
        if (p && advanced === 'committed') {
          const op = p.operations_json[0]!;
          const committed = await tx.selectFrom('operations').select('operation_id').where('operation_id','=',op.operationId).executeTakeFirst();
          if (!committed) throw new AutomationError('automation_stale_input','Committed canonical operation is not yet reconcilable.');
          const facts = await tx.selectFrom('resource_revisions as r').innerJoin('operations as o', join => join.onRef('r.collection_id','=','o.collection_id').onRef('r.ordinal','=','o.commit_ordinal'))
            .select('r.revision').where('o.operation_id','=',op.operationId).where('r.resource_id','=',op.annotationId ?? op.nodeId).executeTakeFirst();
          const version = (await sql<{ version_id: string; content_revision: string }>`SELECT v.version_id,c.content_revision FROM mcp_plan_policy_receipts v
            JOIN mcp_plan_commit_revisions c ON c.plan_id=v.plan_id AND c.collection_id=v.collection_id WHERE v.plan_id=${p.plan_id}`.execute(tx)).rows[0];
          if (!facts || !version) throw new AutomationError('automation_stale_input','Plan history linkage is not yet reconcilable.');
          await sql`INSERT INTO automation_effect_receipts(id,run_id,job_id,step_id,target_partition,plan_id,operation_id,before_revision,after_revision,effect_digest,collection_id,node_id,after_content_revision,version_id)
            VALUES(${randomUUID()},${job.run_id},${id},${id},${job.target_id},${p.plan_id},${op.operationId},${job.input_revision},${facts.revision},${result.proposal_digest},${job.collection_id},${job.node_id},${version.content_revision},${version.version_id})
            ON CONFLICT(run_id,step_id,target_partition) DO NOTHING`.execute(tx);
          await sql`UPDATE automation_results SET status='accepted' WHERE id=${result.id}`.execute(tx);
          await sql`UPDATE automation_jobs SET state='succeeded',revision=revision+1 WHERE id=${id} AND state<>'succeeded'`.execute(tx);
        } else if (advanced) await sql`UPDATE automation_jobs SET state=${advanced === 'review' ? 'review' : advanced},revision=revision+1 WHERE id=${id} AND state<>${advanced}`.execute(tx);
        const row = (await sql<{ state: SubmissionResult['status'] }>`SELECT state FROM automation_jobs WHERE id=${id}`.execute(tx)).rows[0]!;
        const effects = (await sql<{ id: string }>`SELECT id FROM automation_effect_receipts WHERE job_id=${id}`.execute(tx)).rows;
        return { jobId: id,resultId: result.id,proposalDigest: result.proposal_digest,status: row.state,effectReceiptIds: effects.map(e => e.id),diagnostics: [] };
      });
    },
    async guard(tx,planId) {
      const p = (await sql<PinnedProposal>`SELECT * FROM automation_proposals WHERE plan_id=${planId}`.execute(tx)).rows[0];
      if (!p) return;
      const account = await tx.selectFrom('accounts').select('subject_id').where('id','=',p.binding_json.principalId).executeTakeFirstOrThrow();
      const actor: WorkPrincipal = { accountId: p.binding_json.principalId,subjectId: account.subject_id,clientId: p.binding_json.clientId,
        credentialBindingId: p.binding_json.credentialBindingId,scopes: ['automation:work'] };
      await currentInputs(tx,actor,p.job_id);
    },
  };
}
