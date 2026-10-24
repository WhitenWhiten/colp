import { createHash } from 'node:crypto';
export const SOURCE_ARCHIVE_PATH = '/colp/v0.1/sync/source-archives';
export const SOURCE_ARCHIVE_PROFILE = Object.freeze({
  version: 1, sourceAdmission: 1, sourceFinalEffects: 1, sourceAuthorityLease: 1,
  classification: false, classificationDestinationPolicy: false, copies: ['sourceAndSemantic'], maxEdges: 20, leaseMs: 120_000,
});
export class SourceArchiveError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export interface SourceArchiveActor { accountId: string; subjectId: string; credentialId: string; credentialIssuer: string }
export interface SourceArchiveApplication {
  execute(actor: SourceArchiveActor, body: unknown): Promise<unknown>;
}
export interface SourceScope {
  site: 'bilibili'; identityVersion: 1; sourceAccount: string; collectionId: string;
  roots: { ruleId: string; nodeId: string; resourceRevision: string; collectionIds: string[] }[];
  policy: { revision: number; copies: 'sourceAndSemantic' | 'singlePreferSemantic' | 'singleKeepExisting'; backgroundClassification: 'disabled'; sourceRemoval: 'retainArchive' };
  rulesDigest: string; bindingDigest: string;
}
export interface SourceEdge { itemId: string; collectionId: string; collectionTitle: string; title: string; url: string; ruleId: string; entry: 'siteImport' | 'reconcile'; observationDigest: string }
export interface SourceLease { replicaId: string; epoch: number; token: string; expiresAt: number }
export interface SourceFinalEffect { itemId: string; collectionId: string; ruleId: string; nodeId: string; finalParentId: string; resourceRevision: string; operationId: string | null; disposition: 'created' | 'reused' }
export interface SourceCanonicalMutation { kind: 'folder' | 'bookmark'; nodeId: string; parentId: string; operationId: string; resourceRevision: string; contentRevision: string; commitOrdinal: string }
export interface SourceFinalReceipt { version: 1; planId: string; digest: string; epoch: number; collectionId: string; classification: 'disabled'; effects: SourceFinalEffect[]; effectDigest: string; mutations: SourceCanonicalMutation[]; mutationsDigest: string }
export function sourceHash(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, val]) => [k, normalize(val)])) : v;
  return `sha256:${createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')}`;
}
export function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new SourceArchiveError('invalid_source_document', 422);
  return v as Record<string, unknown>;
}
export function text(v: unknown, max = 256): string {
  if (typeof v !== 'string' || !v.length || v.length > max || /[\u0000-\u001f]/u.test(v)) throw new SourceArchiveError('invalid_source_document', 422);
  return v;
}
export function integer(v: unknown, min = 1): number {
  if (!Number.isSafeInteger(v) || Number(v) < min) throw new SourceArchiveError('invalid_source_document', 422); return Number(v);
}
export function digest(v: unknown): string { const s = text(v); if (!/^sha256:[a-f0-9]{64}$/.test(s)) throw new SourceArchiveError('invalid_source_digest', 422); return s; }
export function parseSourceScope(v: unknown): SourceScope {
  const s = object(v, ['site', 'identityVersion', 'sourceAccount', 'collectionId', 'roots', 'policy', 'rulesDigest', 'bindingDigest']);
  if (s.site !== 'bilibili' || s.identityVersion !== 1 || !Array.isArray(s.roots) || !s.roots.length || s.roots.length > 64) throw new SourceArchiveError('unsupported_source_scope', 422);
  const p = object(s.policy, ['revision', 'copies', 'backgroundClassification', 'sourceRemoval']); integer(p.revision);
  if (p.copies !== 'sourceAndSemantic' || p.backgroundClassification !== 'disabled' || p.sourceRemoval !== 'retainArchive') throw new SourceArchiveError('unsupported_source_policy', 422);
  const seen = new Set<string>();
  for (const raw of s.roots) { const r = object(raw, ['ruleId', 'nodeId', 'resourceRevision', 'collectionIds']); text(r.ruleId); text(r.nodeId); text(r.resourceRevision);
    if (seen.has(String(r.ruleId)) || !Array.isArray(r.collectionIds) || !r.collectionIds.length || r.collectionIds.length > 64 || new Set(r.collectionIds).size !== r.collectionIds.length) throw new SourceArchiveError('invalid_source_document', 422);
    seen.add(String(r.ruleId)); r.collectionIds.forEach(x => { if (!/^\d{1,32}$/.test(text(x))) throw new SourceArchiveError('invalid_source_identity', 422); }); }
  if (!/^\d{1,32}$/.test(text(s.sourceAccount))) throw new SourceArchiveError('invalid_source_identity', 422);
  text(s.collectionId); digest(s.rulesDigest); digest(s.bindingDigest); return v as SourceScope;
}
export function parseSourceEdges(v: unknown, scope: SourceScope): SourceEdge[] {
  if (!Array.isArray(v) || !v.length || v.length > SOURCE_ARCHIVE_PROFILE.maxEdges) throw new SourceArchiveError('source_capacity', 422);
  const seen = new Set<string>();
  return v.map(raw => { const e = object(raw, ['itemId', 'collectionId', 'collectionTitle', 'title', 'url', 'ruleId', 'entry', 'observationDigest']);
    if (!/^video:av:[1-9]\d{0,19}$/.test(text(e.itemId)) || !/^\d{1,32}$/.test(text(e.collectionId)) || e.url !== `https://www.bilibili.com/video/av${String(e.itemId).slice(9)}` || !['siteImport', 'reconcile'].includes(String(e.entry))) throw new SourceArchiveError('invalid_source_identity', 422);
    text(e.collectionTitle, 512); text(e.title, 512); digest(e.observationDigest);
    const r = scope.roots.find(x => x.ruleId === e.ruleId && x.collectionIds.includes(String(e.collectionId)));
    const key = JSON.stringify([e.itemId, e.collectionId, e.ruleId]);
    if (!r || seen.has(key)) throw new SourceArchiveError('source_edge_not_admitted', 422); seen.add(key); return raw as SourceEdge;
  });
}
