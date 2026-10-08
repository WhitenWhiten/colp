import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import type { CreateMapping, Mapping, MappingPatch, SourceRef, SourceNodeRef, ExitPreviewInput } from '../domain/types.js';
export class BookmarkSubscriptionError extends Error {
  constructor(readonly code: 'invalid_request'|'invalid_query'|'invalid_cursor'|'resource_not_found'|'revision_conflict'|'precondition_failed'|'precondition_required'|'payload_too_large'|'invalid_document'|'snapshot_expired'|'rate_limited'|'feature_temporarily_unavailable', message = 'Bookmark subscription request could not be completed.') { super(message); }
}
export function fail(code: BookmarkSubscriptionError['code']): never { throw new BookmarkSubscriptionError(code); }
export const revision = (): string => randomUUID();
export const digest = (value: unknown): string => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
export const etag = (value: unknown): string => '"bsp-' + digest(value).slice(7) + '"';
export const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : fail('invalid_request');
export const opaque = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(value) ? value : fail('invalid_request');
export function object(value: unknown, keys: string[], required: string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_request');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(v,k))) return fail('invalid_request');
  return v;
}
export function sourceRef(value: unknown): SourceRef {
  const v=object(value,['sourceType','sourceId']);
  if (v.sourceType !== 'collection' && v.sourceType !== 'digest_series') return fail('invalid_request');
  return { sourceType:v.sourceType, sourceId:opaque(v.sourceId) };
}
export function mappingConfig(type: SourceRef['sourceType'], value: Pick<CreateMapping,'digestMode'|'editionLimit'>): void {
  if (type==='collection' ? value.digestMode!==null || value.editionLimit!==null : value.digestMode==='latest' ? value.editionLimit!==1 : value.digestMode!=='recent' || !Number.isInteger(value.editionLimit) || value.editionLimit!<1 || value.editionLimit!>20) fail('invalid_request');
}
const configKeys=['profileLabel','digestMode','editionLimit','checkIntervalMinutes','exitPolicy'];
export function mappingInput(type: SourceRef['sourceType'], value: unknown, current?: Mapping): CreateMapping | MappingPatch {
  const v=object(value,current?configKeys:['mappingId','profileId','mode',...configKeys],current?[]:undefined);
  if (current && !Object.keys(v).length) fail('invalid_request');
  if (!current) { uuid(v.mappingId); uuid(v.profileId); if(v.mode!=='readonly') fail('invalid_request'); }
  const merged={...current,...v} as CreateMapping;
  if(typeof merged.profileLabel!=='string'||merged.profileLabel.trim().length<1||merged.profileLabel.length>80) fail('invalid_request');
  if(![null,5,15,60].includes(merged.checkIntervalMinutes)) fail('invalid_request');
  const policy=object(merged.exitPolicy,['onUnfollow','onUnsubscribe']);
  if(Object.values(policy).some(x=>!['inherit','keep','remove'].includes(String(x)))) fail('invalid_request');
  mappingConfig(type,merged);
  return v as CreateMapping | MappingPatch;
}
export function exitInput(value: unknown): ExitPreviewInput {
  const v=object(value,['trigger','target']); const t=object(v.target,['kind','mappingId','subscriptionId','sourceType','sourceId'],['kind']);
  if(v.trigger==='unsubscribe' && t.kind==='mapping') { object(t,['kind','mappingId']);uuid(t.mappingId); }
  else if(v.trigger==='unsubscribe' && t.kind==='subscription') {object(t,['kind','subscriptionId']);opaque(t.subscriptionId);}
  else if(v.trigger==='unfollow' && t.kind==='source') {object(t,['kind','sourceType','sourceId']);sourceRef({sourceType:t.sourceType,sourceId:t.sourceId});}
  else fail('invalid_request');
  return v as ExitPreviewInput;
}
export function nodeRefs(value: unknown): SourceNodeRef[] {
  if(!Array.isArray(value)||value.length<1||value.length>128) return fail('invalid_request');
  const nodes=value.map(n=>{ const v=object(n,['sourceCollectionId','nodeId','editionId']); return {sourceCollectionId:opaque(v.sourceCollectionId),nodeId:opaque(v.nodeId),editionId:v.editionId===null?null:opaque(v.editionId)}; });
  if(new Set(nodes.map(n=>canonicalJson(n))).size!==nodes.length) fail('invalid_request');
  return nodes;
}
export function requireMatch(expected: string | undefined, value: unknown): void { if(!expected) fail('precondition_required'); if(expected!==etag(value)) fail('precondition_failed'); }
