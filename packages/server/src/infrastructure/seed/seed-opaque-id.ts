import { createHash } from 'node:crypto';

/**
 * Deterministic 16-byte-shaped opaque IDs for demo seed.
 *
 * Must stay in lockstep with `seed_opaque(prefix, legacy_id)` at the top of
 * `seed/demo/data.sql` (SHA-256 → base64url fill → last char from AQgw).
 *
 * Output is always 22 chars matching `/^[A-Za-z0-9_-]{21}[AQgw]$/u` so social
 * fanout and Canonical lock accept the identity. Prefix is preserved so
 * withdraw `LIKE 'col-u%' / 'col-ce%' / 'nd-col-%'` still matches.
 */

export const SEED_OPAQUE_ID_SALT = 'known-seed:';
export const SEED_OPAQUE_ID_LENGTH = 22;
export const SEED_OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
export const SEED_OPAQUE_LAST_CHARS = 'AQgw';

export const SEED_OPAQUE_PREFIX = {
  collectionUser: 'col-u',
  collectionCelebrity: 'col-ce',
  node: 'nd-col-',
} as const;

export type SeedOpaquePrefix =
  (typeof SEED_OPAQUE_PREFIX)[keyof typeof SEED_OPAQUE_PREFIX];

/** Last-char alphabet + salt + prefixes; import this object when the call site needs the whole mint contract. */
export const SEED_OPAQUE_ID = Object.freeze({
  salt: SEED_OPAQUE_ID_SALT,
  length: SEED_OPAQUE_ID_LENGTH,
  pattern: SEED_OPAQUE_ID_PATTERN,
  lastChars: SEED_OPAQUE_LAST_CHARS,
  prefix: SEED_OPAQUE_PREFIX,
  collection: seedCollectionId,
  node: seedNodeId,
});

export function seedOpaqueId(prefix: string, legacyId: string): string {
  if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length >= 21) {
    throw new Error(`seedOpaqueId prefix must be 1..20 chars, got ${JSON.stringify(prefix)}`);
  }
  if (typeof legacyId !== 'string' || legacyId.length < 1) {
    throw new Error('seedOpaqueId legacyId is required');
  }
  const digest = createHash('sha256').update(`${SEED_OPAQUE_ID_SALT}${legacyId}`, 'utf8').digest();
  const fillLength = 21 - prefix.length;
  const fill = digest.toString('base64url').slice(0, fillLength);
  const last = SEED_OPAQUE_LAST_CHARS[digest[31]! % 4]!;
  const id = `${prefix}${fill}${last}`;
  if (id.length !== SEED_OPAQUE_ID_LENGTH || !SEED_OPAQUE_ID_PATTERN.test(id)) {
    throw new Error(`seedOpaqueId produced a non-canonical id for ${legacyId}`);
  }
  return id;
}

export function seedCollectionId(legacyId: string): string {
  if (legacyId.startsWith(SEED_OPAQUE_PREFIX.collectionCelebrity)) {
    return seedOpaqueId(SEED_OPAQUE_PREFIX.collectionCelebrity, legacyId);
  }
  if (legacyId.startsWith(SEED_OPAQUE_PREFIX.collectionUser)) {
    return seedOpaqueId(SEED_OPAQUE_PREFIX.collectionUser, legacyId);
  }
  throw new Error(`seedCollectionId expected col-u* or col-ce* legacy id, got ${legacyId}`);
}

export function seedNodeId(legacyId: string): string {
  return seedOpaqueId(SEED_OPAQUE_PREFIX.node, legacyId);
}

/**
 * PostgreSQL install statements (one query each).
 * Must stay in lockstep with the CREATE FUNCTION block at the top of seed/demo/data.sql.
 * Injector runs these before data.sql so LANGUAGE sql can resolve public.seed_opaque
 * when the rest of the script is parsed as one batch.
 */
export const SEED_OPAQUE_INSTALL_SQL = Object.freeze([
  `CREATE OR REPLACE FUNCTION seed_opaque(prefix text, legacy_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $seed_opaque$
  SELECT
    prefix
    || substr(b64, 1, 21 - length(prefix))
    || substr('AQgw', (get_byte(digest, 31) % 4) + 1, 1)
  FROM (
    SELECT sha256(convert_to('known-seed:' || legacy_id, 'UTF8')) AS digest
  ) d
  CROSS JOIN LATERAL (
    SELECT translate(rtrim(encode(d.digest, 'base64'), '='), '+/', '-_') AS b64
  ) e
$seed_opaque$`,
  `CREATE OR REPLACE FUNCTION seed_collection_id(legacy_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path FROM CURRENT
AS $seed_collection_id$
  SELECT seed_opaque(
    CASE WHEN legacy_id LIKE 'col-ce%' THEN 'col-ce' ELSE 'col-u' END,
    legacy_id
  )
$seed_collection_id$`,
] as const);

/** data.sql body starts here; injector installs functions first, then executes from this marker. */
export const SEED_DATA_SQL_BODY_MARKER = '-- 0. 资源账本';

export function executableSeedDataSql(dataSql: string): string {
  const idx = dataSql.indexOf(SEED_DATA_SQL_BODY_MARKER);
  if (idx < 0) {
    throw new Error(`data.sql must contain ${JSON.stringify(SEED_DATA_SQL_BODY_MARKER)} after seed_opaque`);
  }
  return dataSql.slice(idx);
}

/** SQL-side encode path (encode base64 + translate + rtrim) for TS/SQL parity tests. */
export function seedOpaqueIdFromSqlBase64(prefix: string, legacyId: string): string {
  const digest = createHash('sha256').update(`${SEED_OPAQUE_ID_SALT}${legacyId}`, 'utf8').digest();
  const b64url = digest.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const fill = b64url.slice(0, 21 - prefix.length);
  const last = SEED_OPAQUE_LAST_CHARS[digest[31]! % 4]!;
  return `${prefix}${fill}${last}`;
}

export function assertSeedOpaqueIdSet(
  pairs: readonly (readonly [prefix: string, legacyId: string])[],
): readonly string[] {
  const seen = new Map<string, string>();
  const ids: string[] = [];
  for (const [prefix, legacyId] of pairs) {
    const id = seedOpaqueId(prefix, legacyId);
    const previous = seen.get(id);
    if (previous !== undefined && previous !== `${prefix}\0${legacyId}`) {
      throw new Error(
        `seedOpaqueId collision: ${id} from (${prefix}, ${legacyId}) and (${previous.replace('\0', ', ')})`,
      );
    }
    seen.set(id, `${prefix}\0${legacyId}`);
    ids.push(id);
  }
  return ids;
}
