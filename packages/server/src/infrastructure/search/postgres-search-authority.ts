import { searchCollectionDiscoverySql } from './collection-discovery-sql.js';
import { sql, type Kysely } from 'kysely';
import {
  SEARCH_CANDIDATE_BATCH_LIMIT,
  SEARCH_MAX_TIMEOUT_MS,
  type SearchAuthorityFact,
  type SearchAuthorityPort,
  type SearchCandidateResourceType,
} from '../../modules/search/index.js';
import type { DatabaseSchema } from '../database/index.js';
import {
  accountRestrictPublicationExistsSql,
  bookmarkDiscoveryExistsSql,
} from '../governance/collection-control-sql.js';

interface AuthorityJsonRow { readonly fact: unknown }

export function createPostgresSearchAuthorityPort(db: Kysely<DatabaseSchema>): SearchAuthorityPort {
  return {
    async loadBatch(input) {
      if (input.signal?.aborted) throw input.signal.reason;
      if (input.candidates.length > SEARCH_CANDIDATE_BATCH_LIMIT || !Number.isInteger(input.timeoutMs)
        || input.timeoutMs < 1 || input.timeoutMs > SEARCH_MAX_TIMEOUT_MS) {
        throw new Error('Search authority batch bounds are invalid.');
      }
      if (input.candidates.length === 0) return [];
      const pairs = new Map<string, { resource_type: SearchCandidateResourceType; resource_id: string }>();
      for (const candidate of input.candidates) {
        if (!isResourceType(candidate.resourceType) || typeof candidate.resourceId !== 'string'
          || candidate.resourceId.length < 1 || candidate.resourceId.length > 512) {
          throw new Error('Search authority candidate identity is invalid.');
        }
        pairs.set(`${candidate.resourceType}:${candidate.resourceId}`, {
          resource_type: candidate.resourceType, resource_id: candidate.resourceId,
        });
      }
      const actorAccountId = input.principal.kind === 'account' ? input.principal.accountId : null;
      const actorPrincipalId = input.principal.kind === 'account' ? input.principal.principalId : null;
      const actorSubjectId = input.principal.kind === 'account' ? input.principal.subjectId : null;
      const actorSecurityEpoch = input.principal.kind === 'account' ? input.principal.securityEpoch : null;
      const requested = JSON.stringify([...pairs.values()]);
      const result = await sql<AuthorityJsonRow>`WITH RECURSIVE verified_actor AS MATERIALIZED (
          SELECT a.subject_id
          FROM accounts a
          WHERE ${input.principal.kind === 'account'}::boolean
            AND a.id=${actorAccountId}::text AND a.id=${actorPrincipalId}::text
            AND a.subject_id=${actorSubjectId}::text
            AND a.security_epoch::text=${actorSecurityEpoch}::text
            AND a.status='active' AND a.deleted_at IS NULL
        ), config AS MATERIALIZED (
          SELECT set_config('statement_timeout',${`${input.timeoutMs}ms`},true)
        ), requested AS MATERIALIZED (
          SELECT DISTINCT resource_type,resource_id
          FROM jsonb_to_recordset(${requested}::jsonb)
            AS r(resource_type text,resource_id text)
        ), subject_seeds AS MATERIALIZED (
          SELECT 'node'::text AS branch,r.resource_id AS request_id,n.collection_id,n.parent_id
          FROM requested r JOIN nodes n ON r.resource_type='node' AND n.id=r.resource_id
          UNION ALL
          SELECT 'annotation'::text,r.resource_id,subject_node.collection_id,subject_node.parent_id
          FROM requested r
          JOIN annotations a ON r.resource_type='annotation' AND a.id=r.resource_id
          JOIN nodes subject_node ON a.subject_type='node'
            AND subject_node.collection_id=a.collection_id AND subject_node.id=a.subject_id
        ), ancestor_walk(branch,request_id,collection_id,id,parent_id,visibility,deleted_at,path,depth,cycle) AS (
          SELECT seed.branch,seed.request_id,seed.collection_id,p.id,p.parent_id,p.visibility,p.deleted_at,
            ARRAY[p.id]::text[],1,false
          FROM subject_seeds seed
          JOIN nodes p ON p.collection_id=seed.collection_id AND p.id=seed.parent_id
          UNION ALL
          SELECT walk.branch,walk.request_id,walk.collection_id,p.id,p.parent_id,p.visibility,p.deleted_at,
            walk.path || p.id,walk.depth+1,p.id=ANY(walk.path)
          FROM ancestor_walk walk
          JOIN nodes p ON p.collection_id=walk.collection_id AND p.id=walk.parent_id
          WHERE NOT walk.cycle AND walk.depth < 256
        ), ancestor_flags AS MATERIALIZED (
          SELECT walk.branch,walk.request_id,bool_or(
            walk.deleted_at IS NOT NULL OR walk.visibility IN ('private','protected') OR walk.cycle
            OR (walk.depth=256 AND walk.parent_id IS NOT NULL)
            OR (walk.parent_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM nodes parent
              WHERE parent.collection_id=walk.collection_id AND parent.id=walk.parent_id
            ))) AS restricted
          FROM ancestor_walk walk GROUP BY walk.branch,walk.request_id
        ), searchable_profile_accounts AS MATERIALIZED (
          SELECT DISTINCT h.account_id
          FROM requested r
          JOIN profile_handles h ON r.resource_type='profile' AND h.handle=r.resource_id
          JOIN accounts a ON a.id=h.account_id
          JOIN collections owned ON owned.owner_subject_id=a.subject_id
            AND owned.deleted_at IS NULL AND owned.visibility='public'
            AND owned.allow_search_indexing=true
            AND ${sql.raw(searchCollectionDiscoverySql('owned'))}
          WHERE NOT ${sql.raw(accountRestrictPublicationExistsSql('a.id'))}
        ), eligible_collections AS NOT MATERIALIZED (
          SELECT c.* FROM collections c
          WHERE c.owner_subject_id=(SELECT subject_id FROM verified_actor)
            OR EXISTS (SELECT 1 FROM collection_members membership
              WHERE membership.collection_id=c.id
                AND membership.subject_id=(SELECT subject_id FROM verified_actor))
            OR ${sql.raw(searchCollectionDiscoverySql('c'))}
        ), collection_facts AS (
          SELECT jsonb_build_object(
            'resourceType','collection','resourceId',c.id,'collectionId',c.id,
            'ownerSubjectId',c.owner_subject_id,'membershipRole',member.role,
            'visibility',c.visibility,'allowSearchIndexing',c.allow_search_indexing,
            'policyRevision',c.policy_revision,'deleted',c.deleted_at IS NOT NULL,
            'title',c.title,
            'snippetSource',search_strip_unsafe_text(coalesce(c.title,'') || ' ' || coalesce(c.summary,''))
          ) AS fact
          FROM requested r CROSS JOIN config
          JOIN eligible_collections c ON r.resource_type='collection' AND c.id=r.resource_id
          LEFT JOIN collection_members member ON member.collection_id=c.id
            AND member.subject_id=(SELECT subject_id FROM verified_actor)
        ), node_facts AS (
          SELECT jsonb_build_object(
            'resourceType','node','resourceId',n.id,'collectionId',c.id,
            'ownerSubjectId',c.owner_subject_id,'membershipRole',member.role,
            'collectionVisibility',c.visibility,'allowSearchIndexing',c.allow_search_indexing,
            'policyRevision',c.policy_revision,'collectionDeleted',c.deleted_at IS NOT NULL,
            'visibility',n.visibility,'ancestorRestricted',(
              coalesce(ancestry.restricted,n.parent_id IS NOT NULL)
              OR ${sql.raw(bookmarkDiscoveryExistsSql('n.id', 'c.id'))}
            ),
            'deleted',n.deleted_at IS NOT NULL OR n.is_root OR n.parent_id IS NULL,
            'title',n.title,'urlHost',n.search_url_host,
            'snippetSource',search_strip_unsafe_text(coalesce(n.title,'') || ' ' || coalesce(n.description,''))
          ) AS fact
          FROM requested r CROSS JOIN config
          JOIN nodes n ON r.resource_type='node' AND n.id=r.resource_id
          JOIN eligible_collections c ON c.id=n.collection_id
          LEFT JOIN collection_members member ON member.collection_id=c.id
            AND member.subject_id=(SELECT subject_id FROM verified_actor)
          LEFT JOIN ancestor_flags ancestry ON ancestry.branch='node' AND ancestry.request_id=r.resource_id
        ), profile_facts AS (
          SELECT jsonb_build_object(
            'resourceType','profile','resourceId',h.handle,
            'accountStatus',a.status,'accountDeleted',a.deleted_at IS NOT NULL,
            'searchablePublicCollection',searchable.account_id IS NOT NULL,
            'handle',h.handle,'displayName',p.display_name,'avatarUrl',p.avatar_url,
            'snippetSource',search_strip_unsafe_text(h.handle || ' ' || p.display_name)
          ) AS fact
          FROM requested r CROSS JOIN config
          JOIN profile_handles h ON r.resource_type='profile' AND h.handle=r.resource_id
          JOIN profiles p ON p.account_id=h.account_id
          JOIN accounts a ON a.id=h.account_id
          LEFT JOIN searchable_profile_accounts searchable ON searchable.account_id=a.id
        ), annotation_facts AS (
          SELECT jsonb_build_object(
            'resourceType','annotation','resourceId',a.id,'collectionId',c.id,
            'ownerSubjectId',c.owner_subject_id,'membershipRole',member.role,
            'collectionVisibility',c.visibility,'allowSearchIndexing',c.allow_search_indexing,
            'policyRevision',c.policy_revision,'collectionDeleted',c.deleted_at IS NOT NULL,
            'visibility',a.visibility,'creatorPrincipalId',a.creator_principal_id,
            'deleted',a.deleted_at IS NOT NULL OR a.type='reading_state',
            'subjectType',a.subject_type,'subjectId',a.subject_id,
            'subjectDeleted',CASE WHEN a.subject_type='collection'
              THEN a.subject_id<>a.collection_id OR c.deleted_at IS NOT NULL
              ELSE subject_node.id IS NULL OR subject_node.deleted_at IS NOT NULL
                OR subject_node.is_root OR subject_node.parent_id IS NULL END,
            'subjectVisibility',CASE WHEN a.subject_type='node' THEN subject_node.visibility END,
            'subjectAncestorRestricted',CASE WHEN a.subject_type='node'
              THEN (
                coalesce(ancestry.restricted,subject_node.parent_id IS NOT NULL)
                OR ${sql.raw(bookmarkDiscoveryExistsSql('a.subject_id', 'a.collection_id'))}
              ) ELSE false END,
            'annotationType',a.type,'snippetSource',coalesce(a.annotation_search_text,'')
          ) AS fact
          FROM requested r CROSS JOIN config
          JOIN annotations a ON r.resource_type='annotation' AND a.id=r.resource_id
          JOIN eligible_collections c ON c.id=a.collection_id
          LEFT JOIN collection_members member ON member.collection_id=c.id
            AND member.subject_id=(SELECT subject_id FROM verified_actor)
          LEFT JOIN nodes subject_node ON a.subject_type='node'
            AND subject_node.collection_id=a.collection_id AND subject_node.id=a.subject_id
          LEFT JOIN ancestor_flags ancestry ON ancestry.branch='annotation'
            AND ancestry.request_id=r.resource_id
        ), all_facts AS (
          SELECT * FROM collection_facts UNION ALL SELECT * FROM node_facts
          UNION ALL SELECT * FROM profile_facts UNION ALL SELECT * FROM annotation_facts
        )
        SELECT fact FROM all_facts`.execute(db, input.signal
        ? { signal: input.signal, inflightQueryAbortStrategy: 'cancel query' }
        : undefined);
      if (input.signal?.aborted) throw input.signal.reason;
      return result.rows.map((row) => parseAuthorityFact(row.fact));
    },
  };
}

function parseAuthorityFact(value: unknown): SearchAuthorityFact {
  if (!isRecord(value) || !isResourceType(value.resourceType)
    || typeof value.resourceId !== 'string' || value.resourceId.length === 0) {
    throw new Error('PostgreSQL returned an invalid Search authority fact.');
  }
  return value as unknown as SearchAuthorityFact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResourceType(value: unknown): value is SearchCandidateResourceType {
  return value === 'collection' || value === 'node' || value === 'profile' || value === 'annotation';
}
