import { validSiteTitle } from './title.js';
import type { AdapterMessage, BootstrapRequest, HostCommand, MembershipReadResult, PageResult, SiteObservation, MembershipHint } from './contracts.js';
import { LIMITS as L } from './limits.js';
import { array, integer, jsonBytes, literal, object, optional, str, union, type Check } from './schema.js';
const id = str(L.id), ids = array(id, L.memberships, 0, x => x);
const byId = (v: unknown) => (v as { id: string }).id;
const safeUrl: Check = v => {
  if (!str(L.url)(v)) return false;
  try { const u = new URL(v as string); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
};
export const itemSchema = object({ id, identity: literal('siteId', 'canonicalUrl'),
  kind: literal('video', 'article', 'post', 'product', 'repository', 'other'), url: safeUrl, title: validSiteTitle });
export const collectionSchema = object({ id, identity: literal('siteId', 'labelOnly'), title: validSiteTitle, parentId: optional(union(id, literal(null))) });
const delta = object({ mode: literal('delta'), added: ids, removed: ids }, v => {
  const d = v as { added: string[]; removed: string[] }; return !d.added.some(x => d.removed.includes(x));
});
const memberships = union(delta, object({ mode: literal('complete'), collectionIds: ids }));
const evidence = union(object({ kind: literal('siteResponse'), operation: id }), object({ kind: literal('settledDom'), detector: id }));
export const observationSchema = union(
  object({ type: literal('catalog.upsert'), collections: optional(array(collectionSchema, L.entities, 1, byId)),
    items: optional(array(itemSchema, L.entities, 1, byId)) }, v => { const d = v as { collections?: unknown; items?: unknown }; return !!(d.collections || d.items); }),
  object({ type: literal('favorite.confirmed'), interactionId: id, item: itemSchema, memberships, confirmation: evidence, sourceRevision: optional(id) }),
  object({ type: literal('membership.observed'), item: itemSchema, memberships, sourceRevision: optional(id) }),
  object({ type: literal('favorite.uncertain'), interactionId: id, itemId: id, reason: literal('timeout', 'ambiguousState', 'accountChanged', 'navigationChanged') }),
);
export const hintSchema = object({ interactionId: id, itemId: id, added: ids, removed: ids,
  code: v => Number.isSafeInteger(v) && Math.abs(v as number) <= 1_000_000_000 }, v => {
  const h = v as MembershipHint;
  return h.added.length + h.removed.length > 0 && h.added.length + h.removed.length <= L.memberships && !h.added.some(x => h.removed.includes(x));
});
export const validMembershipHint = (v: unknown): v is MembershipHint => jsonBytes(v, 8192) && hintSchema(v);
const source = union(object({ state: literal('signedIn'), accountId: id }), object({ state: literal('signedOut', 'unknown') }));
const bootstrapFields = { protocolVersion: literal(1), operation: literal('hello'), adapterId: id, source };
const bootstrapSchema = union(object({ ...bootstrapFields, runtime: literal('bundled'), activationId: id }),
  object({ ...bootstrapFields, runtime: literal('userScript'), installationCredential: str(256) }));
export const failureSchema = object({ code: literal('signedOut', 'pageUnavailable', 'navigationChanged', 'rateLimited', 'unsupported', 'invalidData',
  'timeout', 'cancelled', 'challenge', 'network', 'capacity', 'staleCursor'), retryAfterMs: optional(integer) });
const failed = { status: literal('failed'), error: failureSchema };
const omission = object({ id, reason: literal('invalid', 'unsupported', 'missing', 'failed') });
const page = (entity: Check, key: (v: unknown) => unknown) => {
  const fields = { items: array(entity, L.entities, 0, key), nextCursor: union(str(L.cursor), literal(null)),
    coverage: literal('partial', 'complete'), omissions: optional(array(omission, L.idsPerApiPage, 0, byId)) };
  return union(object({ ...fields, consistency: literal('bestEffort') }), object({ ...fields, consistency: literal('pointInTime'), snapshotId: id }));
};
export const pageResultSchema = union(object(failed),
  object({ status: literal('ok'), kind: literal('collections'), page: page(collectionSchema, byId) }),
  object({ status: literal('ok'), kind: literal('items'), collectionId: id,
    page: page(object({ item: itemSchema, membershipRevision: optional(id) }), v => byId((v as { item: unknown }).item)) }));
const readEvidence = union(object({ kind: literal('siteResponse'), operation: id }), object({ kind: literal('refreshedDom'), detector: id }));
const edge = union(object({ collectionId: id, state: literal('present', 'absent'), evidence: readEvidence }),
  object({ collectionId: id, state: literal('unknown'), reason: literal('notVisible', 'inaccessible', 'unsupported', 'ambiguousState') }));
const membershipSchema = union(object(failed), object({ status: literal('ok'), itemId: id,
  edges: array(edge, L.memberships, 1, v => (v as { collectionId: string }).collectionId), sourceRevision: optional(id) }));
const resolutionSchema = union(object(failed), object({ status: literal('resolved'), item: itemSchema }),
  object({ status: literal('unresolved'), reason: literal('unsupportedUrl', 'ambiguousIdentity', 'pageUnavailable') }));
const envelope = { protocolVersion: literal(1), requestId: id, leaseId: id, capability: str(256) };
// v1 has no host read recipes. Arbitrary params/URLs are never an available fallback.
const messageSchema = union(
  object({ ...envelope, operation: literal('connect') }),
  object({ ...envelope, operation: literal('membership.hint'), hint: hintSchema }),
  object({ ...envelope, operation: literal('emit'), data: observationSchema }),
  object({ ...envelope, operation: literal('capture'), data: object({ type: literal('capture.requested'), item: itemSchema, requestedPurpose: literal('sourceArchive', 'semantic') }) }),
  object({ ...envelope, operation: literal('page.result'), readSessionId: id, pageRequestId: id, result: pageResultSchema }),
  object({ ...envelope, operation: literal('item.result'), resolutionId: id, result: resolutionSchema }),
  object({ ...envelope, operation: literal('membership.result'), readSessionId: id, readRequestId: id, result: membershipSchema }),
);
const query = object({ itemId: id, collectionIds: array(id, L.memberships, 1, x => x) });
const commandFields = { leaseId: id, deadlineAt: integer };
const commandSchema = union(
  object({ ...commandFields, operation: literal('resolveItem'), resolutionId: id, url: safeUrl }),
  object({ ...commandFields, operation: literal('readPage'), readSessionId: id, pageRequestId: id,
    query: union(object({ kind: literal('collections'), cursor: union(str(L.cursor), literal(null)) }),
      object({ kind: literal('items'), collectionId: id, cursor: union(str(L.cursor), literal(null)) })) }),
  object({ ...commandFields, operation: literal('readMemberships'), readSessionId: id, readRequestId: id, query }),
  object({ operation: literal('cancelRead'), readSessionId: id }), object({ operation: literal('invalidateLease', 'shutdown', 'renewLease'), leaseId: id }),
);
export const validBootstrap = (v: unknown): v is BootstrapRequest => jsonBytes(v, 4096) && bootstrapSchema(v);
export const validObservation = (v: unknown): v is SiteObservation => jsonBytes(v, L.observationBytes) && observationSchema(v);
export const validAdapterMessage = (v: unknown): v is AdapterMessage => jsonBytes(v, L.pageBytes) && messageSchema(v)
  && ((v as AdapterMessage).operation !== 'emit' || validObservation((v as { data: unknown }).data));
export const validHostCommand = (v: unknown): v is HostCommand => jsonBytes(v, 16384) && commandSchema(v);
export const validPageResult = (v: unknown): v is PageResult => jsonBytes(v, L.pageBytes) && pageResultSchema(v);
export function validMembershipResult(v: unknown, expected: { itemId: string; collectionIds: readonly string[] }): v is MembershipReadResult {
  if (!jsonBytes(v, L.observationBytes) || !membershipSchema(v)) return false;
  const result = v as MembershipReadResult;
  return result.status === 'failed' || (result.itemId === expected.itemId && result.edges.length === expected.collectionIds.length
    && result.edges.every(e => expected.collectionIds.includes(e.collectionId)));
}
