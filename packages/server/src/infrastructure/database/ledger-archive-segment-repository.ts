import { sql, type Kysely } from 'kysely';

import {
  lifecycleMatchesLinear,
  parseLedgerArchiveLifecycle,
} from './ledger-archive-policy.js';
import type { DatabaseSchema } from './runtime.js';

export const LEDGER_ARCHIVE_STATES = Object.freeze([
  'open',
  'sealed',
  'exported',
  'verified',
  'reader_cutover',
  'detached',
  'deletable',
  'deleted',
] as const);

export type LedgerArchiveSegmentState = (typeof LEDGER_ARCHIVE_STATES)[number];

export interface CreateLedgerArchiveSegmentInput {
  readonly segmentId: string;
  readonly ledgerFamily: string;
  /** Explicit schema-qualified relation, for example `public.operations`. */
  readonly sourceRelation: string;
  /** Explicit source partition/aggregate identity; use `global` only for a truly global sequence. */
  readonly sourceScope: string;
  /** This control plane currently supports only signed bigint append ordinals/ids. */
  readonly sourceKeyKind: 'bigint';
  readonly sourceKeyComparator: 'signed-bigint-ascending-v1';
  /** Canonical half-open append-key interval `[lowerInclusive, upperExclusive)`. */
  readonly sourceKeyBounds: Readonly<{
    lowerInclusive: bigint;
    upperExclusive: bigint;
  }>;
  readonly rowCount: bigint;
  readonly sourceBytes: bigint;
  readonly contentDigest: string;
  /** Stable, credential-free object URI. Signed query strings are rejected by the DB. */
  readonly archiveObjectUri: string;
  readonly archiveObjectEtag: string;
  readonly archiveSchemaVersion: number;
  readonly kmsKeyId: string;
  readonly deleteAfter?: Date | null;
  readonly legalHold?: boolean;
}

export interface LedgerArchiveTransitionInput {
  readonly segmentId: string;
  readonly expectedState: LedgerArchiveSegmentState;
  readonly expectedRevision: bigint;
  readonly targetState: LedgerArchiveSegmentState;
  /** Non-empty, non-secret evidence object appended under `targetState`. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface SetLedgerArchiveLegalHoldInput {
  readonly segmentId: string;
  readonly expectedState: LedgerArchiveSegmentState;
  readonly expectedRevision: bigint;
  readonly legalHold: boolean;
}

export interface ListPendingLedgerArchiveSegmentsInput {
  readonly states?: readonly Exclude<LedgerArchiveSegmentState, 'deleted'>[];
  readonly limit?: number;
}

export interface LedgerArchiveSegment {
  readonly segmentId: string;
  readonly ledgerFamily: string;
  readonly sourceRelation: string;
  readonly sourceScope: string;
  readonly sourceKeyKind: 'bigint';
  readonly sourceKeyComparator: 'signed-bigint-ascending-v1';
  readonly sourceKeyBounds: Readonly<{
    lowerInclusive: bigint;
    upperExclusive: bigint;
  }>;
  readonly rowCount: bigint;
  readonly sourceBytes: bigint;
  readonly contentDigest: string;
  readonly archiveObjectUri: string;
  readonly archiveObjectEtag: string;
  readonly archiveSchemaVersion: number;
  readonly kmsKeyId: string;
  readonly state: LedgerArchiveSegmentState;
  readonly stateRevision: bigint;
  readonly stageEvidence: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sealedAt: Date | null;
  readonly exportedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly readerCutoverAt: Date | null;
  readonly detachedAt: Date | null;
  readonly deletableAt: Date | null;
  readonly deletedAt: Date | null;
  readonly deleteAfter: Date | null;
  readonly legalHold: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerArchiveSegmentRepository {
  readonly create: (input: CreateLedgerArchiveSegmentInput) => Promise<LedgerArchiveSegment>;
  readonly transition: (input: LedgerArchiveTransitionInput) => Promise<LedgerArchiveSegment>;
  readonly setLegalHold: (input: SetLedgerArchiveLegalHoldInput) => Promise<LedgerArchiveSegment>;
  readonly get: (segmentId: string) => Promise<LedgerArchiveSegment | undefined>;
  readonly listPending: (
    input?: ListPendingLedgerArchiveSegmentsInput,
  ) => Promise<readonly LedgerArchiveSegment[]>;
}

export type LedgerArchiveSegmentRepositoryErrorCode =
  | 'segment_exists'
  | 'segment_overlap'
  | 'segment_not_found'
  | 'cas_conflict'
  | 'illegal_transition'
  | 'legal_hold_blocked'
  | 'delete_after_not_reached'
  | 'invalid_segment';

export class LedgerArchiveSegmentRepositoryError extends Error {
  readonly code: LedgerArchiveSegmentRepositoryErrorCode;

  constructor(code: LedgerArchiveSegmentRepositoryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerArchiveSegmentRepositoryError';
    this.code = code;
  }
}

interface SegmentRow {
  segment_id: string;
  ledger_family: string;
  source_relation: string;
  source_scope: string;
  source_key_kind: 'bigint';
  source_key_comparator: 'signed-bigint-ascending-v1';
  source_key_lower: string;
  source_key_upper: string;
  row_count: string;
  source_bytes: string;
  content_digest: string;
  archive_object_uri: string;
  archive_object_etag: string;
  archive_schema_version: number;
  kms_key_id: string;
  state: LedgerArchiveSegmentState;
  state_revision: string;
  stage_evidence: Record<string, Record<string, unknown>>;
  sealed_at: Date | null;
  exported_at: Date | null;
  verified_at: Date | null;
  reader_cutover_at: Date | null;
  detached_at: Date | null;
  deletable_at: Date | null;
  deleted_at: Date | null;
  delete_after: Date | null;
  legal_hold: boolean;
  object_state: string;
  read_state: string;
  hot_source_state: string;
  created_at: Date;
  updated_at: Date;
}

interface ErrorWithPostgresCode {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const SELECT_SEGMENT = sql.raw(`
  segment_id::text,
  ledger_family,
  source_relation,
  source_scope,
  source_key_kind,
  source_key_comparator,
  lower(source_key_bounds)::text AS source_key_lower,
  upper(source_key_bounds)::text AS source_key_upper,
  row_count::text,
  source_bytes::text,
  content_digest,
  archive_object_uri,
  archive_object_etag,
  archive_schema_version,
  kms_key_id,
  state,
  state_revision::text,
  stage_evidence,
  sealed_at,
  exported_at,
  verified_at,
  reader_cutover_at,
  detached_at,
  deletable_at,
  deleted_at,
  delete_after,
  legal_hold,
  object_state,
  read_state,
  hot_source_state,
  created_at,
  updated_at
`);

export function createPostgresLedgerArchiveSegmentRepository(
  db: Kysely<DatabaseSchema>,
): LedgerArchiveSegmentRepository {
  async function get(segmentId: string): Promise<LedgerArchiveSegment | undefined> {
    const result = await sql<SegmentRow>`
      SELECT ${SELECT_SEGMENT}
      FROM ledger_archive_segments
      WHERE segment_id = ${segmentId}::uuid
    `.execute(db);
    const row = result.rows[0];
    return row === undefined ? undefined : mapSegment(row);
  }

  const repository: LedgerArchiveSegmentRepository = Object.freeze({
    async create(input: CreateLedgerArchiveSegmentInput): Promise<LedgerArchiveSegment> {
      if (input.sourceKeyBounds.lowerInclusive >= input.sourceKeyBounds.upperExclusive) {
        throw invalidSegment('Source key bounds must be a non-empty half-open interval.');
      }
      try {
        const result = await sql<SegmentRow>`
          INSERT INTO ledger_archive_segments (
            segment_id, ledger_family, source_relation, source_scope,
            source_key_kind, source_key_comparator, source_key_bounds,
            row_count, source_bytes, content_digest, archive_object_uri,
            archive_object_etag, archive_schema_version, kms_key_id,
            delete_after, legal_hold
          ) VALUES (
            ${input.segmentId}::uuid,
            ${input.ledgerFamily},
            ${input.sourceRelation},
            ${input.sourceScope},
            ${input.sourceKeyKind},
            ${input.sourceKeyComparator},
            int8range(${input.sourceKeyBounds.lowerInclusive}, ${input.sourceKeyBounds.upperExclusive}, '[)'),
            ${input.rowCount},
            ${input.sourceBytes},
            ${input.contentDigest},
            ${input.archiveObjectUri},
            ${input.archiveObjectEtag},
            ${input.archiveSchemaVersion},
            ${input.kmsKeyId},
            ${input.deleteAfter ?? null},
            ${input.legalHold ?? false}
          )
          RETURNING ${SELECT_SEGMENT}
        `.execute(db);
        return mapSegment(requireRow(result.rows[0]));
      } catch (error) {
        throw classifyCreateError(error);
      }
    },

    async transition(input: LedgerArchiveTransitionInput): Promise<LedgerArchiveSegment> {
      if (nextState(input.expectedState) !== input.targetState) {
        throw new LedgerArchiveSegmentRepositoryError(
          'illegal_transition',
          `Archive transition ${input.expectedState} -> ${input.targetState} is not allowed.`,
        );
      }
      if (!isNonEmptyPlainObject(input.evidence)) {
        throw invalidSegment('Transition evidence must be a non-empty JSON object.');
      }

      const evidenceJson = JSON.stringify(input.evidence);
      try {
        const result = await sql<SegmentRow>`
          UPDATE ledger_archive_segments
          SET state = ${input.targetState},
              state_revision = state_revision + 1,
              stage_evidence = stage_evidence
                || jsonb_build_object(${input.targetState}::text, ${evidenceJson}::jsonb)
          WHERE segment_id = ${input.segmentId}::uuid
            AND state = ${input.expectedState}
            AND state_revision = ${input.expectedRevision}
          RETURNING ${SELECT_SEGMENT}
        `.execute(db);
        const row = result.rows[0];
        if (row !== undefined) return mapSegment(row);
      } catch (error) {
        throw classifyTransitionError(error);
      }
      throw await classifyMiss(db, input.segmentId, input.expectedState, input.expectedRevision);
    },

    async setLegalHold(input: SetLedgerArchiveLegalHoldInput): Promise<LedgerArchiveSegment> {
      try {
        const result = await sql<SegmentRow>`
          UPDATE ledger_archive_segments
          SET legal_hold = ${input.legalHold},
              state_revision = state_revision + 1
          WHERE segment_id = ${input.segmentId}::uuid
            AND state = ${input.expectedState}
            AND state_revision = ${input.expectedRevision}
            AND legal_hold IS DISTINCT FROM ${input.legalHold}
          RETURNING ${SELECT_SEGMENT}
        `.execute(db);
        const row = result.rows[0];
        if (row !== undefined) return mapSegment(row);
      } catch (error) {
        throw classifyTransitionError(error);
      }
      throw await classifyMiss(db, input.segmentId, input.expectedState, input.expectedRevision);
    },

    get,

    async listPending(
      input: ListPendingLedgerArchiveSegmentsInput = {},
    ): Promise<readonly LedgerArchiveSegment[]> {
      const states = input.states ?? LEDGER_ARCHIVE_STATES.filter(
        (state): state is Exclude<LedgerArchiveSegmentState, 'deleted'> => state !== 'deleted',
      );
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw invalidSegment('Pending segment limit must be an integer from 1 through 500.');
      }
      if (states.length === 0 || (states as readonly string[]).includes('deleted')) {
        throw invalidSegment('Pending segment states must be non-empty and cannot include deleted.');
      }
      const result = await sql<SegmentRow>`
        SELECT ${SELECT_SEGMENT}
        FROM ledger_archive_segments
        WHERE state = ANY(${states}::text[])
        ORDER BY updated_at ASC, segment_id ASC
        LIMIT ${limit}
      `.execute(db);
      return Object.freeze(result.rows.map(mapSegment));
    },
  });
  return repository;
}

function mapSegment(row: SegmentRow): LedgerArchiveSegment {
  const stored = parseLedgerArchiveLifecycle({
    objectState: row.object_state, readState: row.read_state, hotSourceState: row.hot_source_state,
  });
  if (!lifecycleMatchesLinear(row.state, stored)) {
    throw new LedgerArchiveSegmentRepositoryError(
      'invalid_segment',
      `Archive segment ${row.segment_id} orthogonal lifecycle diverged from linear state.`,
    );
  }
  return Object.freeze({
    segmentId: row.segment_id,
    ledgerFamily: row.ledger_family,
    sourceRelation: row.source_relation,
    sourceScope: row.source_scope,
    sourceKeyKind: row.source_key_kind,
    sourceKeyComparator: row.source_key_comparator,
    sourceKeyBounds: Object.freeze({
      lowerInclusive: BigInt(row.source_key_lower),
      upperExclusive: BigInt(row.source_key_upper),
    }),
    rowCount: BigInt(row.row_count),
    sourceBytes: BigInt(row.source_bytes),
    contentDigest: row.content_digest,
    archiveObjectUri: row.archive_object_uri,
    archiveObjectEtag: row.archive_object_etag,
    archiveSchemaVersion: row.archive_schema_version,
    kmsKeyId: row.kms_key_id,
    state: row.state,
    stateRevision: BigInt(row.state_revision),
    stageEvidence: Object.freeze(row.stage_evidence),
    sealedAt: row.sealed_at,
    exportedAt: row.exported_at,
    verifiedAt: row.verified_at,
    readerCutoverAt: row.reader_cutover_at,
    detachedAt: row.detached_at,
    deletableAt: row.deletable_at,
    deletedAt: row.deleted_at,
    deleteAfter: row.delete_after,
    legalHold: row.legal_hold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function nextState(state: LedgerArchiveSegmentState): LedgerArchiveSegmentState | undefined {
  const index = LEDGER_ARCHIVE_STATES.indexOf(state);
  return LEDGER_ARCHIVE_STATES[index + 1];
}

function isNonEmptyPlainObject(value: Readonly<Record<string, unknown>>): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

function invalidSegment(message: string, cause?: unknown): LedgerArchiveSegmentRepositoryError {
  return new LedgerArchiveSegmentRepositoryError('invalid_segment', message, cause);
}

function postgresFacts(error: unknown): ErrorWithPostgresCode {
  return typeof error === 'object' && error !== null ? error as ErrorWithPostgresCode : {};
}

function classifyCreateError(error: unknown): LedgerArchiveSegmentRepositoryError {
  if (error instanceof LedgerArchiveSegmentRepositoryError) return error;
  const facts = postgresFacts(error);
  if (facts.code === '23505') {
    return new LedgerArchiveSegmentRepositoryError('segment_exists', 'Archive segment already exists.', error);
  }
  if (facts.code === '23P01') {
    return new LedgerArchiveSegmentRepositoryError(
      'segment_overlap',
      'Archive segment source key bounds overlap an existing segment.',
      error,
    );
  }
  return invalidSegment('Archive segment manifest was rejected.', error);
}

function classifyTransitionError(error: unknown): LedgerArchiveSegmentRepositoryError {
  if (error instanceof LedgerArchiveSegmentRepositoryError) return error;
  const constraint = postgresFacts(error).constraint;
  if (constraint === 'ledger_archive_segments_legal_hold_guard'
      || constraint === 'ledger_archive_segments_hold_check') {
    return new LedgerArchiveSegmentRepositoryError(
      'legal_hold_blocked',
      'Legal hold blocks this archive lifecycle transition.',
      error,
    );
  }
  if (constraint === 'ledger_archive_segments_delete_after_guard') {
    return new LedgerArchiveSegmentRepositoryError(
      'delete_after_not_reached',
      'Delete-after has not been reached for this archive segment.',
      error,
    );
  }
  return new LedgerArchiveSegmentRepositoryError(
    'illegal_transition',
    'The database rejected the archive lifecycle transition.',
    error,
  );
}

async function classifyMiss(
  db: Kysely<DatabaseSchema>,
  segmentId: string,
  expectedState: LedgerArchiveSegmentState,
  expectedRevision: bigint,
): Promise<LedgerArchiveSegmentRepositoryError> {
  let result;
  try {
    result = await sql<{
      state: LedgerArchiveSegmentState;
      state_revision: string;
      legal_hold: boolean;
      delete_after: Date | null;
    }>`
      SELECT state, state_revision::text, legal_hold, delete_after
      FROM ledger_archive_segments
      WHERE segment_id = ${segmentId}::uuid
    `.execute(db);
  } catch (error) {
    return invalidSegment('Archive segment identifier was rejected.', error);
  }
  const current = result.rows[0];
  if (current === undefined) {
    return new LedgerArchiveSegmentRepositoryError('segment_not_found', 'Archive segment was not found.');
  }
  if (current.state !== expectedState || BigInt(current.state_revision) !== expectedRevision) {
    return new LedgerArchiveSegmentRepositoryError(
      'cas_conflict',
      'Archive segment state or revision changed concurrently.',
    );
  }
  return new LedgerArchiveSegmentRepositoryError(
    'cas_conflict',
    'Archive segment update did not change the expected row.',
  );
}

function requireRow(row: SegmentRow | undefined): SegmentRow {
  if (row === undefined) throw invalidSegment('Archive segment write returned no row.');
  return row;
}
