import { PUBLICATION_TARGET_ACCESS_MAX_DEPTH } from './collection-control-sql.js';

/** A complete live ancestry is required; malformed chains always resolve private. */
export function buildProductNodeVisibilitySql(nodeAlias: string, collectionAlias: string): string {
  const depth = PUBLICATION_TARGET_ACCESS_MAX_DEPTH;
  return `(with recursive visibility_chain(collection_id,id,parent_id,visibility,deleted_at,path,depth,cycle) as (
    select ${nodeAlias}.collection_id,${nodeAlias}.id,${nodeAlias}.parent_id,${nodeAlias}.visibility,
           ${nodeAlias}.deleted_at,array[${nodeAlias}.id],1,false
    union all
    select p.collection_id,p.id,p.parent_id,p.visibility,p.deleted_at,
           child.path || p.id,child.depth+1,p.id = any(child.path)
      from nodes p join visibility_chain child on p.id = child.parent_id
     where p.collection_id = child.collection_id and not child.cycle and child.depth < ${depth}
  ) select case
    when bool_or(deleted_at is not null or visibility = 'private' or cycle
      or (depth = ${depth} and parent_id is not null)
      or (parent_id is not null and not exists (
        select 1 from nodes ancestor_parent where ancestor_parent.collection_id = visibility_chain.collection_id
          and ancestor_parent.id = visibility_chain.parent_id))) then 'private'
    when bool_or(visibility = 'protected') then 'protected'
    else ${collectionAlias}.visibility end from visibility_chain)`;
}
