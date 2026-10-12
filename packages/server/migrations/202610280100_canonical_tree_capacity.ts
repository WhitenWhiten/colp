import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table canonical_tree_capacity (
    collection_id text primary key references collections(id) on delete cascade,
    serializer_version integer not null,
    live_nodes bigint not null check (live_nodes >= 0),
    node_bytes bigint not null check (node_bytes >= 0),
    parent_count bigint not null check (parent_count >= 0),
    parent_bytes bigint not null check (parent_bytes >= 0)
  )`.execute(db);
  await sql`create table canonical_tree_capacity_entries (
    collection_id text not null references collections(id) on delete cascade,
    node_id text not null,
    node_bytes bigint not null,
    parent_bytes bigint not null,
    primary key (collection_id, node_id)
  )`.execute(db);
  // Dirty facts are transactional and also cover writes outside the canonical
  // facade, including physical deletion. Keep the previous contribution until
  // the reader has subtracted it; a node FK would discard that evidence early.
  await sql`create table canonical_tree_capacity_dirty (
    collection_id text not null references collections(id) on delete cascade
      deferrable initially deferred,
    node_id text not null,
    primary key (collection_id, node_id)
  )`.execute(db);
  await sql`create function mark_canonical_tree_capacity_dirty() returns trigger language plpgsql as $$
    begin
      if TG_OP <> 'INSERT' then
        insert into canonical_tree_capacity_dirty values (OLD.collection_id, OLD.id)
          on conflict do nothing;
      end if;
      if TG_OP <> 'DELETE' then
        insert into canonical_tree_capacity_dirty values (NEW.collection_id, NEW.id)
          on conflict do nothing;
      end if;
      return null;
    end
  $$`.execute(db);
  await sql`create trigger canonical_tree_capacity_node_change
    after insert or update or delete on nodes for each row
    execute function mark_canonical_tree_capacity_dirty()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger canonical_tree_capacity_node_change on nodes`.execute(db);
  await sql`drop function mark_canonical_tree_capacity_dirty()`.execute(db);
  await sql`drop table canonical_tree_capacity_dirty, canonical_tree_capacity_entries,
    canonical_tree_capacity`.execute(db);
}
