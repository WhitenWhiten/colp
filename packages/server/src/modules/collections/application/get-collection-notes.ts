import { AnnotationCursorError, PRODUCT_ANNOTATION_COMPARATOR_VERSION, PRODUCT_ANNOTATION_CURSOR_PURPOSE,
  PRODUCT_ANNOTATION_CURSOR_TTL_MS, PRODUCT_ANNOTATION_CURSOR_VERSION, type ProductAnnotationCursorAfter } from './annotation-cursor.js';
import { AnnotationProductReadError, toProductAnnotationView, type ProductAnnotationReadPorts, type ProductAnnotationPage } from './get-annotation-product.js';
import { formatUtcDateTime } from '../domain/index.js';

/** Owner-only snapshot of this principal's private node notes. The revision also fences all pagination. */
export async function getProductCollectionNotes(ports: ProductAnnotationReadPorts, input: {
  readonly collectionId: string; readonly actor: { principalId: string; subjectId: string };
  readonly cursor?: string; readonly knownRevision?: string;
}): Promise<ProductAnnotationPage & { readonly revision: string; readonly unchanged?: boolean }> {
  const facts = await ports.accessPolicy.loadCollectionFacts({ collectionId: input.collectionId, actorSubjectId: input.actor.subjectId });
  if (!facts || facts.deleted || facts.ownerSubjectId !== input.actor.subjectId) throw new AnnotationProductReadError('annotation_not_found');
  if (!ports.reads.collectionNotesRevision || !ports.reads.listPrivateCollectionNotes) throw new AnnotationProductReadError('invalid_annotation_query');
  const revision = await ports.reads.collectionNotesRevision(input.collectionId);
  if (!revision) throw new AnnotationProductReadError('annotation_not_found');
  const policyRevision = JSON.stringify([facts.policyRevision, revision]);
  const now = await ports.clock.now();
  let after: ProductAnnotationCursorAfter | undefined, issuedAt = formatUtcDateTime(now);
  let expiresAt = formatUtcDateTime(new Date(now.getTime() + (ports.cursorTtlMs ?? PRODUCT_ANNOTATION_CURSOR_TTL_MS)));
  if (input.cursor) {
    let cursor;
    try { cursor = ports.cursorSigner.verify(input.cursor, now); }
    catch (error) { if (error instanceof AnnotationCursorError) throw new AnnotationProductReadError('invalid_cursor'); throw error; }
    if (cursor.scope !== 'product-private-notes' || cursor.collectionId !== input.collectionId || cursor.resourceType !== 'collection'
      || cursor.resourceId !== input.collectionId || cursor.principalId !== input.actor.principalId || cursor.policyRevision !== policyRevision)
      throw new AnnotationProductReadError('invalid_cursor');
    ({ after, issuedAt, expiresAt } = cursor);
  } else if (input.knownRevision === revision) {
    return { revision, unchanged: true, annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } };
  }
  const loaded = await ports.reads.listPrivateCollectionNotes({ collectionId: input.collectionId, principalId: input.actor.principalId, limit: 100, ...(after ? { after } : {}) });
  // Defense against a faulty adapter: no other principal or annotation visibility enters the snapshot.
  if (loaded.some(row => row.collectionId !== input.collectionId || row.subjectType !== 'node' || row.deletedAt !== null
    || row.creatorPrincipalId !== input.actor.principalId || row.payload.visibility !== 'private' || row.payload.type !== 'note'))
    throw new Error('collection_note_authority_mismatch');
  const rows = loaded.slice(0, 100), last = rows.at(-1), hasMore = loaded.length > 100;
  return { revision, annotations: rows.map(row => toProductAnnotationView(row.payload)), page: { returnedCount: rows.length, hasMore,
    nextCursor: hasMore && last ? ports.cursorSigner.sign({ v: PRODUCT_ANNOTATION_CURSOR_VERSION, purpose: PRODUCT_ANNOTATION_CURSOR_PURPOSE,
      principalId: input.actor.principalId, collectionId: input.collectionId, resourceType: 'collection', resourceId: input.collectionId,
      scope: 'product-private-notes', limit: 100, comparatorVersion: PRODUCT_ANNOTATION_COMPARATOR_VERSION, policyRevision,
      after: { updatedAt: formatUtcDateTime(last.updatedAt), id: last.id }, issuedAt, expiresAt }) : null } };
}
