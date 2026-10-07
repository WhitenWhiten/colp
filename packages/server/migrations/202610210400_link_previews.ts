import { sql, type Kysely } from 'kysely';

/**
 * LP-01: bookmark preview images (og:image and relatives).
 *
 * `link_preview_targets` is a cache keyed by the sha256 of the normalized
 * bookmark URL and shared by every account holding that URL. A preview is a
 * property of the URL, not of a node, so no node or account FK exists here.
 * `link_preview_objects` is the ledger of immutable R2 object versions; a row
 * is written before the PUT so a crash or lost lease can never orphan bytes.
 * No FK from the ledger to targets: pruning a target must not block GC.
 *
 * `bookmark_preview_prefs` is the owner veto per bookmark (auto / none).
 * No row means `auto`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE link_preview_targets (
      url_key           text PRIMARY KEY
                        CONSTRAINT link_preview_targets_url_key CHECK (url_key ~ '^[0-9a-f]{64}$'),
      normalized_url    text NOT NULL
                        CONSTRAINT link_preview_targets_url_length CHECK (char_length(normalized_url) <= 4096),
      site              text NOT NULL
                        CONSTRAINT link_preview_targets_site_length CHECK (char_length(site) BETWEEN 1 AND 253),
      status            text NOT NULL DEFAULT 'pending'
                        CONSTRAINT link_preview_targets_status CHECK (status IN ('pending', 'ready', 'none', 'failed')),
      object_id         uuid,
      width             integer,
      height            integer,
      mime              text,
      digest            text,
      generic           boolean NOT NULL DEFAULT false,
      source            text
                        CONSTRAINT link_preview_targets_source CHECK (source IN ('rule', 'og', 'twitter', 'image_src')),
      failures          integer NOT NULL DEFAULT 0
                        CONSTRAINT link_preview_targets_failures CHECK (failures >= 0),
      next_attempt_at   timestamptz NOT NULL DEFAULT current_timestamp,
      last_requested_at timestamptz NOT NULL DEFAULT current_timestamp,
      fetched_at        timestamptz,
      lease_owner       uuid,
      lease_until       timestamptz,
      updated_at        timestamptz NOT NULL DEFAULT current_timestamp,
      -- A readable image always carries its full description; nothing else may.
      CONSTRAINT link_preview_targets_object_shape CHECK (
        (object_id IS NULL AND width IS NULL AND height IS NULL AND mime IS NULL AND digest IS NULL)
        OR (object_id IS NOT NULL AND width > 0 AND height > 0 AND mime IS NOT NULL AND digest IS NOT NULL)
      ),
      CONSTRAINT link_preview_targets_ready_has_object CHECK (status <> 'ready' OR object_id IS NOT NULL)
    )
  `.execute(db);
  await sql`
    CREATE INDEX link_preview_targets_due ON link_preview_targets (next_attempt_at)
      WHERE status IN ('pending', 'failed')
  `.execute(db);
  await sql`
    CREATE INDEX link_preview_targets_site_digest ON link_preview_targets (site, digest)
      WHERE digest IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX link_preview_targets_stale ON link_preview_targets (last_requested_at)`.execute(db);
  await sql`CREATE INDEX link_preview_targets_object ON link_preview_targets (object_id) WHERE object_id IS NOT NULL`.execute(db);

  await sql`
    CREATE TABLE link_preview_objects (
      object_id    uuid PRIMARY KEY,
      url_key      text NOT NULL,
      digest       text NOT NULL,
      deletable_at timestamptz NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
  await sql`CREATE INDEX link_preview_objects_gc ON link_preview_objects (deletable_at)`.execute(db);

  await sql`
    CREATE TABLE bookmark_preview_prefs (
      node_id       text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      mode          text NOT NULL
                    CONSTRAINT bookmark_preview_prefs_mode CHECK (mode IN ('auto', 'none')),
      revision      bigint NOT NULL DEFAULT 1
                    CONSTRAINT bookmark_preview_prefs_revision CHECK (revision >= 1),
      updated_at    timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
  await sql`CREATE INDEX bookmark_preview_prefs_collection_id_idx ON bookmark_preview_prefs (collection_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE bookmark_preview_prefs`.execute(db);
  await sql`DROP TABLE link_preview_objects`.execute(db);
  await sql`DROP TABLE link_preview_targets`.execute(db);
}
