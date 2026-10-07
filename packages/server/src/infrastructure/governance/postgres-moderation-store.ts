import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  GOVERNANCE_EVIDENCE_RETENTION_DAYS,
  parseGovernanceTarget,
  type Evidence,
  type ModerationCaseRecord,
  type ModerationCaseStatus,
  type ModerationCategory,
  type ModerationPageRead,
  type ModerationStore,
} from '../../modules/governance/index.js';
import { createPostgresModerationActionMethods } from './postgres-moderation-actions.js';
import { createPostgresModerationAppealMethods } from './postgres-moderation-appeals.js';

type Executor = Kysely<DatabaseSchema> | DatabaseTransaction;

interface CaseRow {
  id: string;
  reporter_account_id: string;
  target_json: unknown;
  target_fingerprint: string;
  category: string;
  description: string;
  status: string;
  public_resolution: string | null;
  assigned_to_account_id: string | null;
  internal_note: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  evidence_ids: unknown;
  action_ids: unknown;
}

/** The partial unique index powering open-case dedupe (see 202610012500). */
const MODERATION_CASES_OPEN_DEDUPE = 'moderation_cases_open_dedupe';

export function createPostgresModerationStore(executor: Executor): ModerationStore {
  const actions = createPostgresModerationActionMethods(executor);
  const appeals = createPostgresModerationAppealMethods(executor);
  return {
    ...actions,
    ...appeals,
    async insertCase(record) {
      try {
        await sql`
          INSERT INTO moderation_cases (
            id, reporter_account_id, target_kind, target_id, parent_id, target_json,
            target_fingerprint, category, description, status, public_resolution,
            assigned_to_account_id, internal_note, revision, created_at, updated_at
          ) VALUES (
            ${record.id},
            ${record.reporterAccountId},
            ${record.target.kind},
            ${record.target.id},
            ${parentId(record.target)},
            ${JSON.stringify(record.target)}::jsonb,
            ${record.targetFingerprint},
            ${record.category},
            ${record.description},
            ${record.status},
            ${record.publicResolution},
            ${record.assignedToAccountId},
            ${record.internalNote},
            ${record.revision},
            ${new Date(record.createdAt)},
            ${new Date(record.updatedAt)}
          )
        `.execute(executor);
        return 'inserted';
      } catch (error: unknown) {
        const code = (error as { code?: string }).code
          ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code === '23505') {
          // CG-F008: the dedupe partial unique index and the primary key both
          // surface 23505. Only the DEDUPE conflict is an idempotent replay;
          // a primary-key collision (or any future unique conflict) is a real
          // integrity error and must propagate, not be misread as
          // duplicate_open (which would send the caller down the
          // 'disappeared after duplicate' 500 path).
          const constraint = (error as { constraint?: string }).constraint
            ?? (error as { cause?: { constraint?: string } }).cause?.constraint;
          if (constraint === MODERATION_CASES_OPEN_DEDUPE) return 'duplicate_open';
          throw error;
        }
        throw error;
      }
    },
    async findOpenCase(reporterAccountId, targetFingerprint, category) {
      const result = await sql<CaseRow>`
        SELECT c.*, COALESCE((
          SELECT jsonb_agg(e.id ORDER BY e.id)
            FROM moderation_evidence e
           WHERE e.case_id = c.id
        ), '[]'::jsonb) AS evidence_ids, COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM moderation_actions a
           WHERE a.case_id = c.id
        ), '[]'::jsonb) AS action_ids
          FROM moderation_cases c
         WHERE c.reporter_account_id = ${reporterAccountId}
           AND c.target_fingerprint = ${targetFingerprint}
           AND c.category = ${category}
           AND c.status IN ('submitted', 'in_review')
         LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      return row ? mapCase(row) : null;
    },
    async getCase(caseId) {
      const result = await sql<CaseRow>`
        SELECT c.*, COALESCE((
          SELECT jsonb_agg(e.id ORDER BY e.id)
            FROM moderation_evidence e
           WHERE e.case_id = c.id
        ), '[]'::jsonb) AS evidence_ids, COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM moderation_actions a
           WHERE a.case_id = c.id
        ), '[]'::jsonb) AS action_ids
          FROM moderation_cases c
         WHERE c.id = ${caseId}
         LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      return row ? mapCase(row) : null;
    },
    async updateCase(record, expectedRevision) {
      const result = await sql`
        UPDATE moderation_cases
           SET status = ${record.status},
               public_resolution = ${record.publicResolution},
               assigned_to_account_id = ${record.assignedToAccountId},
               internal_note = ${record.internalNote},
               revision = ${record.revision},
               updated_at = ${new Date(record.updatedAt)}
         WHERE id = ${record.id} AND revision = ${expectedRevision}
      `.execute(executor);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
    async listReporterCases(reporterAccountId, read) {
      return listCases(executor, read, reporterAccountId);
    },
    async listOfficialCases(read) {
      return listCases(executor, read, null);
    },
    async insertEvidence(evidence) {
      const encoded = JSON.stringify(evidence);
      const retainUntil = new Date(evidence.capturedAt);
      retainUntil.setUTCDate(retainUntil.getUTCDate() + GOVERNANCE_EVIDENCE_RETENTION_DAYS);
      await sql`
        INSERT INTO moderation_evidence (
          id, case_id, target_json, captured_at, source_revision, title, body_text,
          source_url, truncated, record_bytes, retain_until
        ) VALUES (
          ${evidence.id},
          ${evidence.caseId},
          ${JSON.stringify(evidence.target)}::jsonb,
          ${new Date(evidence.capturedAt)},
          ${evidence.sourceRevision},
          ${evidence.title},
          ${evidence.text},
          ${evidence.sourceUrl},
          ${evidence.truncated},
          ${Buffer.byteLength(encoded, 'utf8')},
          ${retainUntil}
        )
      `.execute(executor);
    },
    async getEvidence(caseId, evidenceId) {
      const result = await sql<{
        id: string;
        case_id: string;
        target_json: unknown;
        captured_at: Date;
        source_revision: string | null;
        title: string | null;
        body_text: string | null;
        source_url: string | null;
        truncated: boolean;
      }>`
        SELECT id, case_id, target_json, captured_at, source_revision, title, body_text,
               source_url, truncated
          FROM moderation_evidence
         WHERE case_id = ${caseId} AND id = ${evidenceId}
         LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        id: row.id,
        caseId: row.case_id,
        target: parseGovernanceTarget(row.target_json),
        capturedAt: row.captured_at.toISOString(),
        sourceRevision: row.source_revision,
        title: row.title,
        text: row.body_text,
        sourceUrl: row.source_url,
        truncated: row.truncated,
      }) satisfies Evidence;
    },
  };
}

async function listCases(
  executor: Executor,
  read: ModerationPageRead,
  reporterAccountId: string | null,
): Promise<readonly ModerationCaseRecord[]> {
  const result = await sql<CaseRow>`
    SELECT c.*, COALESCE((
      SELECT jsonb_agg(e.id ORDER BY e.id)
        FROM moderation_evidence e
       WHERE e.case_id = c.id
    ), '[]'::jsonb) AS evidence_ids, COALESCE((
      SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
        FROM moderation_actions a
       WHERE a.case_id = c.id
    ), '[]'::jsonb) AS action_ids
      FROM moderation_cases c
     WHERE (${reporterAccountId}::text IS NULL OR c.reporter_account_id = ${reporterAccountId})
       AND (${read.status ?? null}::text IS NULL OR c.status = ${read.status ?? null})
       AND (${read.assignee ?? null}::text IS NULL OR c.assigned_to_account_id = ${read.assignee ?? null})
       AND (
         ${read.after?.createdAt ?? null}::timestamptz IS NULL
         OR (c.created_at, c.id) < (${read.after?.createdAt ?? null}::timestamptz, ${read.after?.id ?? ''})
       )
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${read.limit}
  `.execute(executor);
  return Object.freeze(result.rows.map(mapCase));
}

function mapCase(row: CaseRow): ModerationCaseRecord {
  return Object.freeze({
    id: row.id,
    reporterAccountId: row.reporter_account_id,
    target: parseGovernanceTarget(row.target_json),
    targetFingerprint: row.target_fingerprint,
    category: row.category as ModerationCategory,
    description: row.description,
    status: row.status as ModerationCaseStatus,
    publicResolution: row.public_resolution,
    assignedToAccountId: row.assigned_to_account_id,
    internalNote: row.internal_note,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    evidenceIds: mapIds(row.evidence_ids),
    actionIds: mapIds(row.action_ids),
  });
}

function mapIds(value: unknown): readonly string[] {
  return Object.freeze(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
}

function parentId(target: ModerationCaseRecord['target']): string | null {
  if (target.kind === 'bookmark') return target.collectionId;
  if (target.kind === 'digest_edition') return target.seriesId;
  return null;
}
