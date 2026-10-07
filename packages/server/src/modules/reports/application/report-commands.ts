import { createHash } from 'node:crypto';
import { assertCanonicalCommandId, canonicalJson, type ProductCommandClaim, type ProductCommandResult } from '../../commands/index.js';
import {
  assertCanFollowSeries, assertIssueKey, assertPeriod, assertReportSlug as assertReportSlugDomain, assertReportSummary,
  assertReportTitle, assertReportVisibility, isEligiblePublicSource, transitionDigestEdition,
  transitionDigestSeries, type DigestEdition, type DigestMember, type DigestSeries,
} from '../domain/index.js';
import type {
  ReportActor, ReportCommandScope, ReportMutationResult, ReportTransactionPorts,
  ReportUnitOfWork,
} from './contracts.js';
import { reportPublicSurfacePurgeEvent } from './contracts.js';
import type { ReportSourceFacts } from '../domain/types.js';
import { isCanonicalProductPublicCollectionSlug } from '../../publication/index.js';

export type ReportsApplicationErrorCode = 'invalid_request' | 'resource_not_found' | 'forbidden' | 'precondition_failed' | 'conflict' | 'dependency_unavailable' | 'command_id_reused';
export class ReportsApplicationError extends Error { constructor(readonly code: ReportsApplicationErrorCode, message: string) { super(message); this.name = 'ReportsApplicationError'; } }
export interface SeriesCreateInput { readonly actor: ReportActor; readonly commandId: string; readonly title: string; readonly summary?: string | null; readonly slug?: string | null; readonly visibility?: 'private'|'protected'|'unlisted'|'public'; readonly allowSearchIndexing?: boolean; }
export interface SeriesUpdateInput { readonly actor: ReportActor; readonly commandId: string; readonly seriesId: string; readonly expectedRevision: string; readonly title?: string; readonly summary?: string | null; readonly slug?: string | null; readonly visibility?: 'private'|'protected'|'unlisted'|'public'; readonly allowSearchIndexing?: boolean; }
export interface SeriesArchiveInput { readonly actor: ReportActor; readonly commandId: string; readonly seriesId: string; readonly expectedRevision: string; }
export interface EditionAttachInput { readonly actor: ReportActor; readonly commandId: string; readonly seriesId: string; readonly sourceCollectionId: string; readonly issueKey: string; readonly titleSnapshot: string; readonly summarySnapshot?: string | null; readonly periodStart?: string | null; readonly periodEnd?: string | null; }
export interface EditionMutationInput { readonly actor: ReportActor; readonly commandId: string; readonly editionId: string; readonly seriesId?: string; readonly expectedRevision: string; }
export interface EditionUpdateInput { readonly actor: ReportActor; readonly commandId: string; readonly editionId: string; readonly seriesId?: string; readonly expectedRevision: string; readonly titleSnapshot?: string; readonly summarySnapshot?: string | null; readonly periodStart?: string | null; readonly periodEnd?: string | null; }
export interface MemberMutationInput { readonly actor: ReportActor; readonly commandId: string; readonly seriesId: string; readonly subjectId: string; readonly role?: 'editor'|'viewer'; readonly expectedPolicyRevision: string; }
export interface FollowInput { readonly subscriptionExitPreviewId?: string; readonly actor: ReportActor & { readonly profileId: string }; readonly commandId: string; readonly seriesId: string; }
const canonicalReportSlug = (value: string): string => (
  assertReportSlugDomain(value, isCanonicalProductPublicCollectionSlug)
);

const result = (
  value: unknown,
  targetIdentity?: string,
  status = 200,
  etagRevision?: string,
): ProductCommandResult => {
  const stableHeaders: Record<string, string> = { 'cache-control': 'private, no-store' };
  if (status !== 204) {
    stableHeaders['content-type'] = 'application/json';
    const revision = etagRevision ?? (value !== null && typeof value === 'object'
      ? (value as { resourceRevision?: unknown }).resourceRevision
      : undefined);
    if (typeof revision === 'string') stableHeaders.etag = `"${revision}"`;
  }
  return {
    status,
    body: status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)),
    stableHeaders,
    mediaType: status === 204 ? '' : 'application/json',
    contractVersion: 'reports.v1',
    targetIdentity,
  };
};
const mapClaim = (claim: ProductCommandClaim): ReportMutationResult<never> => claim.kind === 'replay' ? { kind: 'replay', result: claim.result } : claim.kind === 'in_progress' ? claim : claim.kind === 'expired' ? claim : { kind: 'reused' };
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const ACTOR_ID = /^(?:[^\u0000-\u001f\u007f]){1,256}$/u;
const id = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new ReportsApplicationError('invalid_request', `${name} is invalid`);
  }
  return value;
};
const actorOk = (actor: ReportActor): void => {
  if (typeof actor.principalId !== 'string' || !ACTOR_ID.test(actor.principalId)
    || typeof actor.subjectId !== 'string' || !ACTOR_ID.test(actor.subjectId)) {
    throw new ReportsApplicationError('invalid_request', 'actor identity is invalid');
  }
};
const claim = async (ports: ReportTransactionPorts, scope: ReportCommandScope, actor: ReportActor, commandId: string, body: unknown): Promise<ReportMutationResult<never> | { binding: { principalId: string; commandScope: string; commandId: string }; fingerprint: string }> => {
  actorOk(actor); try { assertCanonicalCommandId(commandId); } catch { throw new ReportsApplicationError('invalid_request', 'commandId is invalid'); }
  const binding = { principalId: actor.principalId, commandScope: scope, commandId };
  const fingerprint = createHash('sha256').update(canonicalJson({ scope, actor: actor.principalId, body }), 'utf8').digest('hex');
  const c = await ports.receipts.claim(binding, fingerprint); return c.kind === 'claimed' ? { binding, fingerprint } : mapClaim(c);
};
const now = async (ports: ReportTransactionPorts): Promise<Date> => { const value = await ports.clock.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ReportsApplicationError('invalid_request', 'invalid clock'); return value; };
const authorized = async (ports: ReportTransactionPorts, series: DigestSeries, actor: ReportActor, write = false): Promise<'owner'|'editor'|'viewer'> => {
  if (series.ownerSubjectId === actor.subjectId) return 'owner';
  const member = await ports.members.get(series.id, actor.subjectId);
  if (!member || member.revokedAt || (write && member.role === 'viewer')) throw new ReportsApplicationError('forbidden', 'insufficient report membership');
  return member.role;
};
const readSourceForActor = async (ports: ReportTransactionPorts, collectionId: string, actor: ReportActor): Promise<ReportSourceFacts> => {
  // Never fall back to an unscoped metadata read: doing so turns a missing
  // adapter wiring into an object-level authorization bypass.
  if (!ports.source.getForActor) {
    throw new ReportsApplicationError('resource_not_found', 'source not found');
  }
  const verdict = await ports.source.getForActor(collectionId, actor);
  if (verdict.verdict === 'dependency_unavailable') {
    throw new ReportsApplicationError('dependency_unavailable', 'source dependency unavailable');
  }
  if ((verdict.verdict !== 'authorized' && verdict.verdict !== 'public') || !verdict.facts) {
    // Conceal foreign/private source existence from report editors.
    throw new ReportsApplicationError('resource_not_found', 'source not found');
  }
  if (verdict.facts.collectionId !== collectionId) {
    throw new ReportsApplicationError('resource_not_found', 'source not found');
  }
  return verdict.facts;
};
const emit = async (ports: ReportTransactionPorts, actor: ReportActor, action: string, target: { seriesId?: string; editionId?: string }, changed: Record<string, unknown>, at: Date, eventType: 'reports.series.changed@1'|'reports.edition.changed@1') => {
  const eventId = ports.ids.nextEventId();
  await ports.audit.append({ eventId, principalId: actor.principalId, principalType: 'subject', action, ...target, changed, occurredAt: at, details: {} });
  await ports.outbox.append({ outboxId: ports.ids.nextOutboxId(), eventId, eventType, eventVersion: 1, handlerName: 'reports_projection', handlerMode: 'projection_latest_only', occurredAt: at, payload: { ...target, ...changed } });
};

async function emitPublicSurfacePurge(
  ports: ReportTransactionPorts,
  series: DigestSeries,
  at: Date,
): Promise<void> {
  if (!ports.publicSurfacePurgeEnabled || series.slug === null) return;
  await ports.outbox.append(reportPublicSurfacePurgeEvent(ports.ids, {
    seriesId: series.id,
    slug: series.slug,
    revision: series.resourceRevision,
    surfaces: ['html', 'json', 'sitemap', 'og'],
    occurredAt: at,
  }));
}

export async function createDigestSeries(uow: ReportUnitOfWork, input: SeriesCreateInput): Promise<ReportMutationResult<DigestSeries>> {
  return uow.execute(async ports => {
    const c = await claim(ports, 'reports.series.create', input.actor, input.commandId, input);
    if ('kind' in c) return c as ReportMutationResult<DigestSeries>;
    const title = assertReportTitle(input.title);
    const summary = assertReportSummary(input.summary ?? null);
    const visibility = assertReportVisibility(input.visibility ?? 'private');
    const slug = input.slug == null ? null : canonicalReportSlug(input.slug);
    if (input.allowSearchIndexing !== undefined && typeof input.allowSearchIndexing !== 'boolean') {
      throw new ReportsApplicationError('invalid_request', 'allowSearchIndexing is invalid');
    }
    if (visibility !== 'private' && !slug) throw new ReportsApplicationError('invalid_request', 'public series requires slug');
    const at = await now(ports);
    const series: DigestSeries = Object.freeze({
      id: ports.ids.nextResourceId('digest_series'), ownerSubjectId: input.actor.subjectId,
      title, summary, slug, visibility, allowSearchIndexing: input.allowSearchIndexing ?? false,
      state: 'active', resourceRevision: ports.revision.next(), contentRevision: ports.revision.next(),
      policyRevision: ports.revision.next(),
    });
    await ports.series.insert(series);
    await ports.members.ensureOwner({ seriesId: series.id, subjectId: input.actor.subjectId, role: 'owner', revokedAt: null });
    await emit(ports, input.actor, 'series.created', { seriesId: series.id }, {
      resourceRevision: series.resourceRevision, contentRevision: series.contentRevision,
      policyRevision: series.policyRevision, state: series.state, visibility: series.visibility,
    }, at, 'reports.series.changed@1');
    await emitPublicSurfacePurge(ports, series, at);
    await ports.receipts.complete(c.binding, c.fingerprint, result(series, series.id, 201));
    return { kind: 'succeeded', value: series };
  });
}

export async function updateDigestSeries(uow: ReportUnitOfWork, input: SeriesUpdateInput): Promise<ReportMutationResult<DigestSeries>> {
 return uow.execute(async ports => {
   const c = await claim(ports, 'reports.series.update', input.actor, input.commandId, input);
   if ('kind' in c) return c as ReportMutationResult<DigestSeries>;
   const current = await ports.series.lockById(id(input.seriesId, 'seriesId'));
   if (!current || current.state === 'archived') throw new ReportsApplicationError('resource_not_found', 'report not found');
   const role = await authorized(ports, current, input.actor, true);

   // Editors may change presentation metadata only.  Treat the presence of a
   // policy key as a policy mutation even when its value happens to be equal
   // to the current value; this keeps the owner-only boundary explicit and
   // prevents callers from smuggling a future policy field through this API.
   const policyMutation = input.visibility !== undefined || input.slug !== undefined
     || input.allowSearchIndexing !== undefined;
   if (policyMutation && role !== 'owner') {
     throw new ReportsApplicationError('forbidden', 'only owner may change report policy');
   }
   if (input.allowSearchIndexing !== undefined && typeof input.allowSearchIndexing !== 'boolean') {
     throw new ReportsApplicationError('invalid_request', 'allowSearchIndexing is invalid');
   }
   if (!ports.revision.matches(current.resourceRevision, input.expectedRevision)) {
     throw new ReportsApplicationError('precondition_failed', 'report revision mismatch');
   }
   const nextVisibility = input.visibility === undefined ? current.visibility : assertReportVisibility(input.visibility);
   const nextSlug = input.slug === undefined
     ? current.slug
     : (input.slug === null ? null : canonicalReportSlug(input.slug));
   if (nextVisibility !== 'private' && !nextSlug) throw new ReportsApplicationError('invalid_request', 'public series requires slug');
   // A report locator is an identity, not mutable metadata.  This also
   // rejects clearing a slug after it was first assigned.
   if (current.slug !== null && nextSlug !== current.slug) {
     throw new ReportsApplicationError('conflict', 'report slug is immutable');
   }
   if ((nextVisibility === 'public' || nextVisibility === 'unlisted') && role !== 'owner') {
     throw new ReportsApplicationError('forbidden', 'only owner may publicize report');
   }
   const nextIndexing = input.allowSearchIndexing ?? current.allowSearchIndexing;
   const policyChanged = nextVisibility !== current.visibility
     || nextSlug !== current.slug || nextIndexing !== current.allowSearchIndexing;
   const nextTitle = input.title === undefined ? current.title : assertReportTitle(input.title);
   const nextSummary = input.summary === undefined ? current.summary : assertReportSummary(input.summary);
   const contentChanged = nextTitle !== current.title || nextSummary !== current.summary;
   const updated = await ports.series.update(current.id, {
     title: nextTitle,
     summary: nextSummary,
     slug: nextSlug,
     visibility: nextVisibility,
     allowSearchIndexing: nextIndexing,
     resourceRevision: ports.revision.next(),
     ...(contentChanged ? { contentRevision: ports.revision.next() } : {}),
     ...(policyChanged ? { policyRevision: ports.revision.next() } : {}),
   });
   const at = await now(ports);
   await emit(ports, input.actor, 'series.updated', { seriesId: updated.id }, {
     resourceRevision: updated.resourceRevision, contentRevision: updated.contentRevision,
     policyRevision: updated.policyRevision, state: updated.state, visibility: updated.visibility,
   }, at, 'reports.series.changed@1');
   await emitPublicSurfacePurge(ports, updated, at);
   await ports.receipts.complete(c.binding, c.fingerprint, result(updated, updated.id));
   return { kind: 'succeeded', value: updated };
 });
}

export async function archiveDigestSeries(uow: ReportUnitOfWork, input: SeriesArchiveInput): Promise<ReportMutationResult<DigestSeries>> {
  return uow.execute(async ports => {
    const c = await claim(ports, 'reports.series.archive', input.actor, input.commandId, input);
    if ('kind' in c) return c as ReportMutationResult<DigestSeries>;
    const current = await ports.series.lockById(id(input.seriesId, 'seriesId'));
    if (!current) throw new ReportsApplicationError('resource_not_found', 'report not found');
    // Archival is an irreversible lifecycle/policy change, not an editor write.
    // Check the owner on the locked row before revisions, scheduling or events.
    if (current.ownerSubjectId !== input.actor.subjectId) {
      throw new ReportsApplicationError('forbidden', 'only owner may archive report');
    }
    if (!ports.revision.matches(current.resourceRevision, input.expectedRevision)) {
      throw new ReportsApplicationError('precondition_failed', 'report revision mismatch');
    }
    const updated = await ports.series.update(current.id, {
      state: transitionDigestSeries(current.state, 'archive'),
      contentRevision: ports.revision.next(), resourceRevision: ports.revision.next(), policyRevision: ports.revision.next(),
    });
    await ports.series.disableSchedule?.(current.id);
    const at = await now(ports);
    await emit(ports, input.actor, 'series.archived', { seriesId: current.id }, {
      resourceRevision: updated.resourceRevision, contentRevision: updated.contentRevision,
      policyRevision: updated.policyRevision, state: updated.state, visibility: updated.visibility,
    }, at, 'reports.series.changed@1');
    await emitPublicSurfacePurge(ports, updated, at);
    await ports.receipts.complete(c.binding, c.fingerprint, result(null, updated.id, 204));
    return { kind: 'succeeded', value: updated };
  });
}

async function bumpSeriesContent(ports: ReportTransactionPorts, series: DigestSeries): Promise<DigestSeries> {
  return ports.series.update(series.id, {
    contentRevision: ports.revision.next(),
    resourceRevision: ports.revision.next(),
  });
}

async function emitSeriesProjection(
  ports: ReportTransactionPorts,
  actor: ReportActor,
  action: string,
  series: DigestSeries,
  at: Date,
): Promise<void> {
  await emit(ports, actor, action, { seriesId: series.id }, {
    contentRevision: series.contentRevision,
    policyRevision: series.policyRevision,
    resourceRevision: series.resourceRevision,
    state: series.state,
    visibility: series.visibility,
  }, at, 'reports.series.changed@1');
}

export async function attachDigestEdition(uow: ReportUnitOfWork, input: EditionAttachInput): Promise<ReportMutationResult<DigestEdition>> {
  return uow.execute(async ports => {
    const c = await claim(ports, 'reports.edition.attach', input.actor, input.commandId, input);
    if ('kind' in c) return c as ReportMutationResult<DigestEdition>;
    const series = await ports.series.lockById(id(input.seriesId, 'seriesId'));
    if (!series || series.state !== 'active') throw new ReportsApplicationError('resource_not_found', 'report not found');
    await authorized(ports, series, input.actor, true);
    const source = await readSourceForActor(ports, id(input.sourceCollectionId, 'sourceCollectionId'), input.actor);
    const issueKey = assertIssueKey(input.issueKey);
    if (ports.editions.findByIssueKey && await ports.editions.findByIssueKey(series.id, issueKey)) {
      throw new ReportsApplicationError('conflict', 'issue key already exists');
    }
    const [periodStart, periodEnd] = assertPeriod(input.periodStart ?? null, input.periodEnd ?? null);
    const at = await now(ports);
    const edition: DigestEdition = Object.freeze({
      id: ports.ids.nextResourceId('digest_edition'), seriesId: series.id,
      sourceCollectionId: source.collectionId, issueKey,
      editionOrdinal: await ports.series.nextEditionOrdinal(series.id),
      titleSnapshot: assertReportTitle(input.titleSnapshot),
      summarySnapshot: assertReportSummary(input.summarySnapshot ?? null),
      sourceContentRevision: source.contentRevision, sourcePolicyRevision: null,
      resourceRevision: ports.revision.next(), periodStart, periodEnd,
      state: 'draft', publishedAt: null,
    });
    await ports.editions.insert(edition);
    const updatedSeries = await bumpSeriesContent(ports, series);
    await emit(ports, input.actor, 'edition.attached', { seriesId: series.id, editionId: edition.id }, {
      resourceRevision: edition.resourceRevision, state: edition.state,
    }, at, 'reports.edition.changed@1');
    await emitSeriesProjection(ports, input.actor, 'series.content_changed', updatedSeries, at);
    await emitPublicSurfacePurge(ports, updatedSeries, at);
    await ports.receipts.complete(c.binding, c.fingerprint, result(edition, edition.id, 201));
    return { kind: 'succeeded', value: edition };
  });
}

async function mutateEdition(uow: ReportUnitOfWork, input: EditionMutationInput, action: 'publish'|'withdraw'|'detach'): Promise<ReportMutationResult<DigestEdition>> {
  return uow.execute(async ports => {
    const c = await claim(ports, `reports.edition.${action}` as ReportCommandScope, input.actor, input.commandId, input);
    if ('kind' in c) return c as ReportMutationResult<DigestEdition>;
    const edition = await ports.editions.lockById(id(input.editionId, 'editionId'));
    if (!edition) throw new ReportsApplicationError('resource_not_found', 'report not found');
    if (input.seriesId !== undefined && edition.seriesId !== id(input.seriesId, 'seriesId')) throw new ReportsApplicationError('resource_not_found', 'report not found');
    const series = await ports.series.lockById(edition.seriesId);
    if (!series || series.state === 'archived') throw new ReportsApplicationError('resource_not_found', 'report not found');
    const role = await authorized(ports, series, input.actor, true);
    if (!ports.revision.matches(edition.resourceRevision, input.expectedRevision)) throw new ReportsApplicationError('precondition_failed', 'edition revision mismatch');
    const publicSeries = series.visibility === 'public' || series.visibility === 'unlisted';
    if (publicSeries && (action === 'publish' || action === 'withdraw') && role !== 'owner') {
      throw new ReportsApplicationError('forbidden', 'only the owner can publish or withdraw public issues');
    }
    const source = action === 'publish' ? await readSourceForActor(ports, edition.sourceCollectionId, input.actor) : null;
    if (action === 'publish' && publicSeries && (!source || !isEligiblePublicSource(source))) {
      throw new ReportsApplicationError('conflict', 'source is not eligible for public publication');
    }
    const at = await now(ports);
    const state = transitionDigestEdition(edition.state, action);
    const publishedAt = action === 'publish' ? at.toISOString() : edition.publishedAt;
    const updated = await ports.editions.update(edition.id, {
      state,
      sourcePolicyRevision: action === 'publish' ? source!.policyRevision : edition.sourcePolicyRevision,
      publishedAt,
      resourceRevision: ports.revision.next(),
    });
    const updatedSeries = await bumpSeriesContent(ports, series);
    await emit(ports, input.actor, `edition.${action}ed`, { seriesId: series.id, editionId: edition.id }, {
      resourceRevision: updated.resourceRevision, state: updated.state,
    }, at, 'reports.edition.changed@1');
    await emitSeriesProjection(ports, input.actor, 'series.content_changed', updatedSeries, at);
    await emitPublicSurfacePurge(ports, updatedSeries, at);
    await ports.receipts.complete(c.binding, c.fingerprint, result(action === 'detach' ? null : updated, updated.id, action === 'detach' ? 204 : 200));
    return { kind: 'succeeded', value: updated };
  });
}
export const publishDigestEdition = (uow: ReportUnitOfWork, input: EditionMutationInput) => mutateEdition(uow, input, 'publish');
export const withdrawDigestEdition = (uow: ReportUnitOfWork, input: EditionMutationInput) => mutateEdition(uow, input, 'withdraw');
export const detachDigestEdition = (uow: ReportUnitOfWork, input: EditionMutationInput) => mutateEdition(uow, input, 'detach');

export async function updateDigestEdition(uow: ReportUnitOfWork, input: EditionUpdateInput): Promise<ReportMutationResult<DigestEdition>> {
  return uow.execute(async ports => {
    const c = await claim(ports, 'reports.edition.update', input.actor, input.commandId, input); if ('kind' in c) return c as ReportMutationResult<DigestEdition>;
    const edition = await ports.editions.lockById(id(input.editionId, 'editionId')); if (!edition) throw new ReportsApplicationError('resource_not_found', 'report not found');
    if (input.seriesId !== undefined && edition.seriesId !== id(input.seriesId, 'seriesId')) throw new ReportsApplicationError('resource_not_found', 'report not found');
    const series = await ports.series.lockById(edition.seriesId); if (!series || series.state === 'archived') throw new ReportsApplicationError('resource_not_found', 'report not found');
    await authorized(ports, series, input.actor, true); if (edition.state !== 'draft') throw new ReportsApplicationError('conflict', 'only draft issues can be edited');
    if (!ports.revision.matches(edition.resourceRevision, input.expectedRevision)) throw new ReportsApplicationError('precondition_failed', 'edition revision mismatch');
    const [periodStart, periodEnd] = assertPeriod(input.periodStart === undefined ? edition.periodStart : input.periodStart, input.periodEnd === undefined ? edition.periodEnd : input.periodEnd);
    const updated = await ports.editions.update(edition.id, { titleSnapshot: input.titleSnapshot === undefined ? edition.titleSnapshot : assertReportTitle(input.titleSnapshot), summarySnapshot: input.summarySnapshot === undefined ? edition.summarySnapshot : assertReportSummary(input.summarySnapshot), periodStart, periodEnd, resourceRevision: ports.revision.next() });
    const updatedSeries = await bumpSeriesContent(ports, series);
    const at = await now(ports); await emit(ports, input.actor, 'edition.updated', { seriesId: series.id, editionId: edition.id }, { resourceRevision: updated.resourceRevision, state: updated.state }, at, 'reports.edition.changed@1'); await emitSeriesProjection(ports, input.actor, 'series.content_changed', updatedSeries, at); await emitPublicSurfacePurge(ports, updatedSeries, at); await ports.receipts.complete(c.binding, c.fingerprint, result(updated, updated.id)); return { kind: 'succeeded', value: updated };
  });
}

export async function upsertDigestMember(uow: ReportUnitOfWork, input: MemberMutationInput): Promise<ReportMutationResult<DigestMember>> {
  return uow.execute(async ports => {
    const c = await claim(ports, 'reports.member.upsert', input.actor, input.commandId, input); if ('kind' in c) return c as ReportMutationResult<DigestMember>;
    const series = await ports.series.lockById(id(input.seriesId, 'seriesId')); if (!series || series.state === 'archived') throw new ReportsApplicationError('resource_not_found', 'report not found');
    if (series.ownerSubjectId !== input.actor.subjectId) throw new ReportsApplicationError('forbidden', 'owner only');
    if (!ports.revision.matches(series.policyRevision, input.expectedPolicyRevision)) throw new ReportsApplicationError('precondition_failed', 'policy revision mismatch');
    if ((input.role !== 'editor' && input.role !== 'viewer') || !ports.members.upsert) {
      throw new ReportsApplicationError('invalid_request', 'member role is required');
    }
    if (input.subjectId === series.ownerSubjectId) throw new ReportsApplicationError('conflict', 'owner membership is immutable');
    if (!ports.members.isActiveSubject || !(await ports.members.isActiveSubject(id(input.subjectId, 'subjectId')))) {
      throw new ReportsApplicationError('resource_not_found', 'member subject not found');
    }
    const member = await ports.members.upsert({ seriesId: series.id, subjectId: id(input.subjectId, 'subjectId'), role: input.role, revokedAt: null });
    const updatedSeries = await ports.series.update(series.id, { policyRevision: ports.revision.next(), resourceRevision: ports.revision.next() });
    const at = await now(ports); await emit(ports, input.actor, 'member.updated', { seriesId: series.id }, { contentRevision: updatedSeries.contentRevision, policyRevision: updatedSeries.policyRevision, resourceRevision: updatedSeries.resourceRevision, state: updatedSeries.state, visibility: updatedSeries.visibility }, at, 'reports.series.changed@1'); const response = result(member, series.id, 200, updatedSeries.policyRevision); await ports.receipts.complete(c.binding, c.fingerprint, response); return { kind: 'succeeded', value: member, response };
  });
}

export async function revokeDigestMember(uow: ReportUnitOfWork, input: MemberMutationInput): Promise<ReportMutationResult<null>> {
  return uow.execute(async ports => {
    const c = await claim(ports, 'reports.member.revoke', input.actor, input.commandId, input); if ('kind' in c) return c as ReportMutationResult<null>;
    const series = await ports.series.lockById(id(input.seriesId, 'seriesId')); if (!series || series.state === 'archived') throw new ReportsApplicationError('resource_not_found', 'report not found');
    if (series.ownerSubjectId !== input.actor.subjectId) throw new ReportsApplicationError('forbidden', 'owner only');
    if (!ports.revision.matches(series.policyRevision, input.expectedPolicyRevision)) throw new ReportsApplicationError('precondition_failed', 'policy revision mismatch');
    if (input.subjectId === series.ownerSubjectId || !ports.members.revoke) throw new ReportsApplicationError('conflict', 'owner membership is immutable');
    await ports.members.revoke(series.id, id(input.subjectId, 'subjectId')); const updatedSeries = await ports.series.update(series.id, { policyRevision: ports.revision.next(), resourceRevision: ports.revision.next() });
    const at = await now(ports); await emit(ports, input.actor, 'member.revoked', { seriesId: series.id }, { contentRevision: updatedSeries.contentRevision, policyRevision: updatedSeries.policyRevision, resourceRevision: updatedSeries.resourceRevision, state: updatedSeries.state, visibility: updatedSeries.visibility }, at, 'reports.series.changed@1'); const response = result(null, series.id, 204); await ports.receipts.complete(c.binding, c.fingerprint, response); return { kind: 'succeeded', value: null, response };
  });
}

export async function followDigestSeries(
  uow: ReportUnitOfWork,
  input: FollowInput,
  action: 'follow' | 'unfollow' = 'follow',
): Promise<ReportMutationResult<{ following: boolean; followedAt: Date | null; followerCount: number }>> {
  return uow.execute(async (ports) => {
    const c = await claim(ports, 'reports.follow', input.actor, input.commandId, { ...input, action });
    if ('kind' in c) return c as ReportMutationResult<{ following: boolean; followedAt: Date | null; followerCount: number }>;
    await ports.subscriptionExit?.lockAccount(input.actor.principalId);
    if (!ports.follows || !(await ports.follows.lockActiveProfile(input.actor.profileId))) {
      throw new ReportsApplicationError('resource_not_found', 'report not found');
    }
    const series = await ports.series.lockById(id(input.seriesId, 'seriesId'));
    if (!series || series.state === 'archived' || (series.visibility !== 'public' && series.visibility !== 'unlisted')) {
      throw new ReportsApplicationError('resource_not_found', 'report not found');
    }
    assertCanFollowSeries(input.actor.subjectId, series.ownerSubjectId);
    const at = await now(ports);
    const changed = action === 'follow'
      ? await ports.follows.upsert(series.id, input.actor.profileId, at)
      : await ports.follows.remove(series.id, input.actor.profileId, at);
    const followedAt: Date | null = action === 'follow' && 'followedAt' in changed ? changed.followedAt : null;
    const value = {
      following: action === 'follow',
      followedAt,
      followerCount: await ports.follows.countActive?.(series.id) ?? 0,
    };
    const updatedSeries = changed.changed
      ? await ports.series.update(series.id, { resourceRevision: ports.revision.next() })
      : series;
    if (changed.changed) { await emitSeriesProjection(ports, input.actor, 'series.followers_changed', updatedSeries, at); await emitPublicSurfacePurge(ports, updatedSeries, at); }
    if(action==='unfollow') await ports.subscriptionExit?.unfollow({accountId:input.actor.principalId,subjectId:input.actor.subjectId,source:{sourceType:'digest_series',sourceId:series.id},...(input.subscriptionExitPreviewId?{previewId:input.subscriptionExitPreviewId}:{})});
    const response = result(value, series.id);
    await ports.receipts.complete(c.binding, c.fingerprint, response);
    return { kind: 'succeeded', value, response };
  }, {isolationLevel:'read committed'});
}
export const unfollowDigestSeries = (uow: ReportUnitOfWork, input: FollowInput) => followDigestSeries(uow, input, 'unfollow');

// Short aliases used by transport/composition layers.
export const createSeries = createDigestSeries;
export const updateSeries = updateDigestSeries;
export const archiveSeries = archiveDigestSeries;
export const attachEdition = attachDigestEdition;
export const publishEdition = publishDigestEdition;
export const withdrawEdition = withdrawDigestEdition;
export const detachEdition = detachDigestEdition;
export const followSeries = followDigestSeries;
export const unfollowSeries = unfollowDigestSeries;
export const updateEdition = updateDigestEdition;
export const upsertMember = upsertDigestMember;
export const revokeMember = revokeDigestMember;