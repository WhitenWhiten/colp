import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Follow-up to `202609230300_subject_id_reference_cascade`.
 *
 * That migration remapped `collections.owner_subject_id` to the Better Auth
 * user.id and originally left `payload_json.ownerSubjectId` on the old value.
 * Canonical collection writes compare the stored payload to the relational
 * projection and fail closed on `resource_field_authority_violation`, so
 * Library "Add bookmark" returned 500 `internal_error` after T-03.
 *
 * Align the derived payload copy to the already-authoritative column.
 * Rows without `ownerSubjectId` (catalog-only seed payloads) are unchanged.
 * `down` is a documented no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE collections
       SET payload_json = jsonb_set(payload_json, '{ownerSubjectId}', to_jsonb(owner_subject_id))
     WHERE payload_json ? 'ownerSubjectId'
       AND payload_json->>'ownerSubjectId' IS DISTINCT FROM owner_subject_id
  `.execute(db);
}

/** Data backfill cannot be undone without stealing later application writes. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // no-op
}

export const migration: Migration = { up, down };
export default migration;
