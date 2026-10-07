/**
 * CS-04 community comment-area settings: getCommunityCommentSettings and
 * setCommunityCommentSettings — the per-target lock behind
 * GET|PUT /api/v1/community/comment-settings and
 * known.community.comments.configure.
 *
 * One settings row per comment-area target identity, deliberately
 * GENERATION-INDEPENDENT: locking a bookmark's comment area survives a
 * source-URL generation advance while comments themselves stay
 * generation-pinned. The absent row is the virtual default (`locked=false`,
 * revision '1', `updatedAt` = the target's stable created_at). The
 * independent settings ETag compares verbatim in If-Match — a stale tag is
 * 412 precondition_failed with the current tag attached. `locked=true`
 * rejects later comment writes on the target for everyone.
 *
 * The GET query repeats the comment-list target validation exactly
 * (kind/id + conditional parents + required generation); the PUT body is
 * the closed PutCommentSettings {target, locked, reason}. A curator is the
 * target owner or an active owner/editor member of the governing
 * collection/series.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import type {
  CommunityTargetViewer,
  ResolvedCommunityTarget,
} from './community-target-query.js';
import {
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_KINDS,
  CommunityTargetError,
  communityTargetIdentity,
  communityTargetMatches,
  parseCommunityTarget,
  type CommunityTarget,
  type CommunityTargetIdentity,
  type CommunityTargetKind,
  type CommunityTargetQuery,
} from './community-target.js';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE,
  COMMUNITY_SETTINGS_PRECONDITION_MESSAGE,
  COMMUNITY_SETTINGS_VIRTUAL_REVISION,
  COMMUNITY_COMMENT_TARGET_STALE_MESSAGE,
  CommunityCommentError,
  communityCommentSettingsView,
  communityCommentSettingsVirtual,
  normalizeCommunityReason,
  type CommunityCommentSettings,
  type CommunityCommentSettingsRecord,
} from './community-comment.js';
import {
  COMMUNITY_COMMENT_SETTINGS_SCOPE,
  communityCommentInvalidRequest,
  communityCommentPreconditionFailed,
  manageResult,
  mapManageClaim,
  validateManageActor,
  validateManageCommandId,
  validateManageIfMatch,
  type CommunityCommentManageActor,
  type CommunityCommentManagePorts,
  type CommunityCommentManageResult,
} from './community-comment-manage.js';

/** Read ports for getCommunityCommentSettings; the PUT uses the shared manage ports. */
export interface CommunityCommentSettingsQueryPorts {
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
    /** Stable creation stamp of the target authority row (virtual `updatedAt`). */
    createdAt(identity: CommunityTargetIdentity): Promise<Date | null>;
  };
  readonly curators: {
    canCurate(identity: CommunityTargetIdentity, subjectId: string): Promise<boolean>;
  };
  readonly settings: {
    find(identity: CommunityTargetIdentity): Promise<CommunityCommentSettingsRecord | null>;
  };
}

/** Normalized GET query — the comment-list target shape without paging. */
export interface CommunityCommentSettingsQuery {
  readonly kind: CommunityTargetKind;
  readonly id: string;
  readonly collectionId: string | null;
  readonly seriesId: string | null;
  readonly generation: string;
}

/** Normalized PutCommentSettings {target, locked, reason}. */
export interface CommunityCommentSettingsWrite {
  readonly target: CommunityTarget;
  readonly locked: boolean;
  readonly reason: string;
}

export interface CommunityCommentSettingsInput {
  readonly actor: CommunityCommentManageActor;
  readonly target: unknown;
  readonly locked: unknown;
  readonly reason: unknown;
  readonly ifMatch: unknown;
  readonly commandId: string;
}

const SETTINGS_QUERY_KEYS = ['collectionId', 'generation', 'id', 'kind', 'seriesId'] as const;
const SETTINGS_BODY_KEYS = ['locked', 'reason', 'target'] as const;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function invalidQuery(message: string): CommunityCommentError {
  return new CommunityCommentError('invalid_query', message);
}

function concealed(): CommunityCommentError {
  return new CommunityCommentError('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE);
}

/**
 * Parse the closed settings query. Identical validation to the comment
 * list's target fields: `kind`, `id`, and `generation` required;
 * `collectionId` required exactly for bookmark, `seriesId` exactly for
 * digest_edition, every other combination forbids the parent key. A
 * non-bookmark generation must be the literal `static-v1`; a bookmark
 * generation is any opaque id later compared against the resolved
 * authority. Null is never equivalent to missing.
 */
export function parseCommunityCommentSettingsQuery(
  raw: Readonly<Record<string, unknown>>,
): CommunityCommentSettingsQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidQuery('The community comment settings query is invalid.');
  }
  for (const key of Object.keys(raw)) {
    if (!(SETTINGS_QUERY_KEYS as readonly string[]).includes(key)) {
      throw invalidQuery('The community comment settings query is invalid.');
    }
  }
  const kind = raw.kind;
  if (typeof kind !== 'string'
      || !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(kind)) {
    throw invalidQuery('The community comment settings kind is invalid.');
  }
  const id = raw.id;
  if (typeof id !== 'string' || !OPAQUE_ID.test(id)) {
    throw invalidQuery('The community comment settings id is invalid.');
  }
  const generation = raw.generation;
  if (typeof generation !== 'string' || generation.length < 1 || generation.length > 128) {
    throw invalidQuery('The community comment settings generation is invalid.');
  }
  if (kind === 'bookmark') {
    if (!OPAQUE_ID.test(generation)) {
      throw invalidQuery('The community comment settings generation is invalid.');
    }
  } else if (generation !== COMMUNITY_STATIC_GENERATION) {
    throw invalidQuery('The community comment settings generation is invalid.');
  }
  const collectionId = raw.collectionId;
  const seriesId = raw.seriesId;
  if (collectionId !== undefined
      && (typeof collectionId !== 'string' || !OPAQUE_ID.test(collectionId))) {
    throw invalidQuery('The community comment settings collectionId is invalid.');
  }
  if (seriesId !== undefined
      && (typeof seriesId !== 'string' || !OPAQUE_ID.test(seriesId))) {
    throw invalidQuery('The community comment settings seriesId is invalid.');
  }
  let normalizedCollectionId: string | null = null;
  let normalizedSeriesId: string | null = null;
  switch (kind as CommunityTargetKind) {
    case 'bookmark':
      if (collectionId === undefined) {
        throw invalidQuery('A bookmark comment settings query requires collectionId.');
      }
      if (seriesId !== undefined) {
        throw invalidQuery('A bookmark comment settings query forbids seriesId.');
      }
      normalizedCollectionId = collectionId as string;
      break;
    case 'digest_edition':
      if (seriesId === undefined) {
        throw invalidQuery('A digest_edition comment settings query requires seriesId.');
      }
      if (collectionId !== undefined) {
        throw invalidQuery('A digest_edition comment settings query forbids collectionId.');
      }
      normalizedSeriesId = seriesId as string;
      break;
    default:
      if (collectionId !== undefined || seriesId !== undefined) {
        throw invalidQuery(`A ${kind} comment settings query forbids parent ids.`);
      }
  }
  return Object.freeze<CommunityCommentSettingsQuery>({
    kind: kind as CommunityTargetKind,
    id,
    collectionId: normalizedCollectionId,
    seriesId: normalizedSeriesId,
    generation,
  });
}

/**
 * Parse the closed PutCommentSettings {target, locked, reason}. Unknown
 * keys reject; `target` reuses the CS-01 closed-object parser (generation
 * syntax included); `locked` must be a literal boolean; `reason` is the
 * required 1..1000 code-point justification (required for unlock writes
 * too — the wire exposes it only while locked).
 */
export function parseCommunityCommentSettingsBody(value: unknown): CommunityCommentSettingsWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw communityCommentInvalidRequest('The community comment settings body is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== SETTINGS_BODY_KEYS.length
      || SETTINGS_BODY_KEYS.some((key) => !keys.includes(key))) {
    throw communityCommentInvalidRequest('The community comment settings body is invalid.');
  }
  let target: CommunityTarget;
  try {
    target = parseCommunityTarget(record.target);
  } catch (error) {
    if (error instanceof CommunityTargetError) {
      throw communityCommentInvalidRequest(error.message);
    }
    throw error;
  }
  if (typeof record.locked !== 'boolean') {
    throw communityCommentInvalidRequest('The community comment settings locked flag is invalid.');
  }
  return Object.freeze<CommunityCommentSettingsWrite>({
    target,
    locked: record.locked,
    reason: normalizeCommunityReason(record.reason),
  });
}

function settingsTargetQuery(query: CommunityCommentSettingsQuery): CommunityTargetQuery {
  return {
    kind: query.kind,
    id: query.id,
    ...(query.collectionId !== null ? { collectionId: query.collectionId } : {}),
    ...(query.seriesId !== null ? { seriesId: query.seriesId } : {}),
  };
}

function authenticatedCurator(
  viewer: CommunityTargetViewer,
): asserts viewer is { accountId: string; subjectId: string } {
  if (viewer.accountId === null || viewer.subjectId === null) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE);
  }
}

/**
 * Read the comment-area settings of one target. The target must resolve
 * and the supplied generation must equal the resolved generation — a stale
 * generation conceals the area exactly like a stale comment list. Then the
 * viewer must be a curator of the target.
 */
export async function getCommunityCommentSettings(
  ports: CommunityCommentSettingsQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly query: CommunityCommentSettingsQuery;
  },
): Promise<CommunityCommentSettings> {
  const { query } = input;
  const resolved = await ports.targets.resolve(settingsTargetQuery(query));
  if (resolved === null || query.generation !== resolved.target.generation) {
    throw concealed();
  }
  authenticatedCurator(input.viewer);
  if (!(await ports.curators.canCurate(communityTargetIdentity(resolved.target), input.viewer.subjectId))) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE);
  }
  const identity = communityTargetIdentity(resolved.target);
  const row = await ports.settings.find(identity);
  if (row !== null) {
    return communityCommentSettingsView(row, resolved.target);
  }
  const createdAt = await ports.targets.createdAt(identity);
  if (createdAt === null) throw concealed();
  return communityCommentSettingsVirtual(resolved.target, createdAt);
}

export function communityCommentSettingsCommandFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly target: CommunityTarget;
  readonly locked: boolean;
  readonly reason: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    target: input.target,
    locked: input.locked,
    reason: input.reason,
    contractVersion: '1.0.0',
  }), 'utf8').digest('hex');
}

/**
 * Curator lock/unlock: the supplied target must equal the currently
 * resolved identity AND generation (a stale generation is 409
 * revision_conflict so the curator re-resolves and confirms on the new
 * content — the stored settings row itself is generation-independent).
 * The If-Match tag must equal the current settings ETag (the virtual tag
 * before any write); the new row revision increments the compared one.
 * Every write appends an immutable audit event.
 */
export async function setCommunityCommentSettings(
  ports: CommunityCommentManagePorts,
  input: CommunityCommentSettingsInput,
): Promise<CommunityCommentManageResult<CommunityCommentSettings>> {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw communityCommentInvalidRequest('Community comment settings command input is required.');
  }
  validateManageActor(input.actor);
  let write: CommunityCommentSettingsWrite;
  try {
    write = parseCommunityCommentSettingsBody({
      target: input.target, locked: input.locked, reason: input.reason,
    });
  } catch (error) {
    if (error instanceof CommunityCommentError) {
      throw communityCommentInvalidRequest(error.message);
    }
    throw error;
  }
  const ifMatch = validateManageIfMatch(input.ifMatch);
  const commandId = validateManageCommandId(input.commandId);
  const fingerprint = communityCommentSettingsCommandFingerprint({
    actorPrincipalId: input.actor.principalId,
    target: write.target, locked: write.locked, reason: write.reason,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: COMMUNITY_COMMENT_SETTINGS_SCOPE,
    commandId,
  };
  const account = await ports.actor.lockActiveAccount(input.actor.principalId);
  if (account === null || account.subjectId !== input.actor.subjectId) {
    throw new CommunityCommentError('resource_not_found', 'The community target was not found.');
  }
  const resolved = await ports.targets.lockResolved(communityTargetIdentity(write.target));
  if (resolved === null) throw concealed();
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapManageClaim(claim);
  if (!communityTargetMatches(write.target, resolved.target)) {
    throw new CommunityCommentError('revision_conflict', COMMUNITY_COMMENT_TARGET_STALE_MESSAGE);
  }
  const identity = communityTargetIdentity(resolved.target);
  if (!(await ports.curators.canCurate(identity, input.actor.subjectId))) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE);
  }
  const existing = await ports.settings.lockByTarget(identity);
  const currentRevision = existing === null
    ? COMMUNITY_SETTINGS_VIRTUAL_REVISION
    : existing.revision.toString();
  const currentEtag = ports.etags.settings({
    target: resolved.target,
    revision: currentRevision,
  });
  if (ifMatch !== currentEtag) {
    throw communityCommentPreconditionFailed(COMMUNITY_SETTINGS_PRECONDITION_MESSAGE, currentEtag);
  }
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw communityCommentInvalidRequest('The command clock returned invalid time.');
  }
  const stored = await ports.settings.upsert(Object.freeze<CommunityCommentSettingsRecord>({
    target: identity,
    locked: write.locked,
    reason: write.reason,
    // The virtual default is revision '1'; the first stored row is 2.
    revision: (existing?.revision ?? 1n) + 1n,
    updatedByAccountId: input.actor.principalId,
    updatedAt: now,
  }));
  await ports.audit.append({
    eventType: 'community.comment_settings_updated',
    principalId: input.actor.principalId,
    details: {
      targetKind: identity.kind,
      targetId: identity.id,
      targetCollectionId: identity.collectionId,
      targetSeriesId: identity.seriesId,
      locked: write.locked,
      reason: write.reason,
      revision: stored.revision.toString(),
    },
    createdAt: now,
  });
  // Project the response through the same effective overlay the read path
  // applies (loadCommunityCommentSettings overlays an active official
  // lock_comments action). While the official lock is in effect the area
  // stays locked even though the curator row is written unlocked, so the
  // PUT must not contradict the next GET: the durable unlock intent is kept
  // in the stored row, the response reflects the authoritative state. The
  // re-read never returns null — the row was just upserted.
  const effective = (await ports.settings.lockByTarget(identity)) ?? stored;
  const settings = communityCommentSettingsView(effective, resolved.target);
  await ports.receipts.complete(binding, fingerprint,
    manageResult(settings, ports.etags.settings(settings),
      `comment-settings:${identity.kind}:${identity.id}`));
  return { kind: 'succeeded', value: settings };
}
