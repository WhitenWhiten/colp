import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Seed 版本管理权威表（P? seed-import 方案 M1）。
 *
 * - seed_applied：每套 seed（seed_key）当前应用状态（applied/withdrawn）与
 *   注入时 manifest 快照；「避免二次注入」与「版本变化自动换版」的判定依据。
 * - seed_applied_history：每次 applied/withdrawn 事件追加记录（审计，只增不改）。
 * - seed_rows：注入行登记（table + 主键 jsonb），撤回的精确删除依据——
 *   只删登记过的行，业务数据不可能被前缀误删。
 *
 * 三表仅由 seed runner（src/infrastructure/seed/run.ts）读写；N-1 读者忽略。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE seed_applied (
    seed_key text PRIMARY KEY CHECK (length(seed_key) BETWEEN 1 AND 128),
    version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
    state text NOT NULL DEFAULT 'applied' CHECK (state IN ('applied','withdrawn')),
    applied_at timestamptz NOT NULL DEFAULT now(),
    withdrawn_at timestamptz,
    applied_by text,
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    CHECK (withdrawn_at IS NULL OR state = 'withdrawn'),
    CHECK (applied_at > '-infinity'::timestamptz AND applied_at < 'infinity'::timestamptz),
    CHECK (withdrawn_at IS NULL OR (withdrawn_at > '-infinity'::timestamptz AND withdrawn_at < 'infinity'::timestamptz))
  )`.execute(db);
  await sql`COMMENT ON TABLE seed_applied IS
    'Seed 版本管理权威：每套 seed 的当前应用状态与注入时 manifest 快照。'`.execute(db);

  await sql`CREATE TABLE seed_applied_history (
    id bigserial PRIMARY KEY,
    seed_key text NOT NULL CHECK (length(seed_key) BETWEEN 1 AND 128),
    version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
    event text NOT NULL CHECK (event IN ('applied','withdrawn')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    by text,
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb
  )`.execute(db);
  await sql`CREATE INDEX seed_applied_history_key_time_idx
    ON seed_applied_history(seed_key, occurred_at DESC, id DESC)`.execute(db);
  await sql`COMMENT ON TABLE seed_applied_history IS
    'Seed 应用/撤回事件审计日志（只增不改）。'`.execute(db);

  await sql`CREATE TABLE seed_rows (
    seed_key text NOT NULL CHECK (length(seed_key) BETWEEN 1 AND 128),
    version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
    table_name text NOT NULL CHECK (length(table_name) BETWEEN 1 AND 128),
    pk jsonb NOT NULL CHECK (jsonb_typeof(pk) = 'array' AND jsonb_array_length(pk) >= 1),
    PRIMARY KEY (seed_key, version, table_name, pk)
  )`.execute(db);
  await sql`CREATE INDEX seed_rows_lookup_idx
    ON seed_rows(seed_key, version, table_name)`.execute(db);
  await sql`COMMENT ON TABLE seed_rows IS
    'Seed 注入行登记（主键 jsonb 数组，按 manifest.pk_columns 顺序）；撤回的精确删除依据。'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS seed_rows`.execute(db);
  await sql`DROP TABLE IF EXISTS seed_applied_history`.execute(db);
  await sql`DROP TABLE IF EXISTS seed_applied`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
