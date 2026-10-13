import { sql } from 'kysely';
import { validateAutomation,type TaskSpec,type TaskInput,type TaskOutput } from '@know-n/colp/automation';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { readWorkerNotes } from './worker-notes.js';

interface InputSource {
  ownerId: string; serverUuid: string; collectionId: string; nodeId: string; runId: string; sourceEventId: string;
  payload: Record<string,unknown>;
}
type InputPreparation = { kind: 'blocked'; reason: string } | {
  kind: 'ready'; input: TaskInput; revisions: Record<string,string>;
  predecessors: Record<string,{ resultId: string; digest: string }>;
};

/** Build a single immutable, schema-valid allowlisted snapshot; no provider/network fallback. */
export async function prepareTaskInput(tx: DatabaseTransaction,task: TaskSpec,source: InputSource): Promise<InputPreparation> {
  const { serverUuid,collectionId,nodeId,runId,sourceEventId,payload } = source;
  const input: TaskInput = { node: { serverUuid,collectionId,nodeId },sourceEventId,availability: 'available' };
  const revisions: Record<string,string> = {};
  for (const field of task.inputFields) {
    switch (field) {
      case 'url': case 'title': case 'description':
        if (typeof payload[field] === 'string') input[field]=payload[field];
        break;
      case 'tags':
        if (Array.isArray(payload.tags) && payload.tags.every((tag): tag is string => typeof tag === 'string')) input.tags=payload.tags;
        break;
      case 'note': {
        const notes = await readWorkerNotes(tx,source.ownerId,collectionId,nodeId);
        if (notes.length > 1 || (notes[0] && typeof notes[0].payload_json.value !== 'string'))
          return { kind: 'blocked',reason: 'The requested note is ambiguous or unreadable; no arbitrary note is selected.' };
        if (notes[0]) { input.note=notes[0].payload_json.value as string;revisions[notes[0].id]=notes[0].resource_revision; }
        break;
      }
      default: return { kind: 'blocked',reason: `Requested ${field} is unavailable; no implicit network/model fallback.` };
    }
  }
  const predecessors: Record<string,{ resultId: string; digest: string }> = {};
  for (const taskId of task.after) {
    const result = (await sql<{ id: string; proposal_digest: string; output_json: TaskOutput }>`SELECT coalesce(a.id,c.id) AS id,coalesce(a.proposal_digest,c.digest) AS proposal_digest,coalesce(a.output_json,c.output_json) AS output_json
      FROM automation_jobs j LEFT JOIN automation_results a ON a.id=coalesce(j.result_id,j.reused_result_id) AND a.status='accepted'
      LEFT JOIN automation_task_completions c ON c.job_id=j.id
      WHERE j.run_id=${runId} AND j.task_id=${taskId} AND j.state='succeeded' AND (a.id IS NOT NULL OR c.id IS NOT NULL)`.execute(tx)).rows[0];
    if (!result) return { kind: 'blocked',reason: 'A declared predecessor has no accepted typed result.' };
    predecessors[taskId]={ resultId: result.id,digest: result.proposal_digest };
    (input.acceptedPredecessors ??= []).push({ taskId,resultId: result.id,digest: result.proposal_digest,output: result.output_json });
  }
  if (!validateAutomation('TaskInput',input).valid || Buffer.byteLength(JSON.stringify(input),'utf8')>262_144)
    return { kind: 'blocked',reason: 'Allowlisted input exceeds the installed TaskInput contract or 256 KiB bound.' };
  return { kind: 'ready',input,revisions,predecessors };
}

/** Batch input membership is fixed at admission. Unavailable members cause review, never replacement. */
export async function prepareRunInputs(tx: DatabaseTransaction,task: TaskSpec,source: InputSource,
  members?: readonly {eventId:string;nodeId:string;revision:string}[]) {
  const sources=members ?? [{eventId:source.sourceEventId,nodeId:source.nodeId,revision:''}];
  const inputs:TaskInput[]=[],revisions:Record<string,string>={},memberRevisions:Record<string,string>={};
  let predecessors:Record<string,{resultId:string;digest:string}>={};
  for(const member of sources){
    let payload=source.payload;
    if(members){
      const node=await tx.selectFrom('nodes').select(['resource_revision','payload_json']).where('collection_id','=',source.collectionId)
        .where('id','=',member.nodeId).where('deleted_at','is',null).executeTakeFirst();
      if(!node || node.resource_revision!==member.revision)return {kind:'blocked' as const,reason:'An immutable batch member is unavailable or changed; review the original batch. No replacement was selected.'};
      payload=node.payload_json ?? {};memberRevisions[member.nodeId]=node.resource_revision;
    }
    const result=await prepareTaskInput(tx,task,{...source,nodeId:member.nodeId,sourceEventId:member.eventId,payload});
    if(result.kind==='blocked')return result;
    inputs.push(result.input);Object.assign(revisions,result.revisions);predecessors=result.predecessors;
  }
  if(Buffer.byteLength(JSON.stringify(inputs),'utf8')>4_194_304)return {kind:'blocked' as const,reason:'Pinned batch input exceeds the 4 MiB job budget; no partial batch is sent.'};
  return {kind:'ready' as const,input:inputs[0]!,inputs,revisions,predecessors,memberRevisions};
}
