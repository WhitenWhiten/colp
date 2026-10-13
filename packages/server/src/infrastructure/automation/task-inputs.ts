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
    const result = (await sql<{ id: string; proposal_digest: string; output_json: TaskOutput }>`SELECT a.id,a.proposal_digest,a.output_json
      FROM automation_jobs j JOIN automation_results a ON a.id=coalesce(j.result_id,j.reused_result_id)
      WHERE j.run_id=${runId} AND j.task_id=${taskId} AND a.status='accepted'`.execute(tx)).rows[0];
    if (!result) return { kind: 'blocked',reason: 'A declared predecessor has no accepted typed result.' };
    predecessors[taskId]={ resultId: result.id,digest: result.proposal_digest };
    (input.acceptedPredecessors ??= []).push({ taskId,resultId: result.id,digest: result.proposal_digest,output: result.output_json });
  }
  if (!validateAutomation('TaskInput',input).valid || Buffer.byteLength(JSON.stringify(input),'utf8')>262_144)
    return { kind: 'blocked',reason: 'Allowlisted input exceeds the installed TaskInput contract or 256 KiB bound.' };
  return { kind: 'ready',input,revisions,predecessors };
}
