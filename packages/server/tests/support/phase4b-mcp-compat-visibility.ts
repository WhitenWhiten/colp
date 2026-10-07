/**
 * Shared T-05 visibility projection: same list/read semantics as
 * `phase4b-mcp-collection-resources.test.ts` (directory is public+protected
 * only; unlisted/private exist for exact-URI read).
 */
import { createHash } from 'node:crypto';
import { loadConfig } from './test-config.js';
import {
  createMcpOauthVerifier,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  type Phase4bMcpCollectionResourceProjection,
} from '../../src/modules/mcp/index.js';
import { createPublicationCursorKeyring } from '../../src/modules/publication/index.js';
import type { AccessPolicyFactsPort } from '../../src/modules/access-policy/index.js';
import { compatJsonRpc } from './phase4b-mcp-compat-admission.js';
import {
  AUDIENCE,
  NOW,
  SERVER_UUID,
  createKeyFixture,
  mcpEnv,
  mintCredential,
  staticJwksProvider,
  verifierOptions,
} from './phase4b-mcp-transport-scaffold.js';

export const COMPAT_VISIBILITY_OWNER = 'subject-owner';
export const COMPAT_VISIBILITY_MEMBER = 'subject-member';
export const COMPAT_VISIBILITY_OUTSIDER = 'subject-outsider';

const OWNER = COMPAT_VISIBILITY_OWNER;
const MEMBER = COMPAT_VISIBILITY_MEMBER;

interface FixtureCollection {
  readonly id: string;
  readonly title: string;
  readonly visibility: 'public' | 'protected' | 'private' | 'unlisted';
  readonly ownerSubjectId: string;
  readonly member?: string;
  readonly updatedAt: string;
}

const fixtureCollections: readonly FixtureCollection[] = Object.freeze([
  Object.freeze({
    id: 'public-b',
    title: 'Public B',
    visibility: 'public',
    ownerSubjectId: OWNER,
    updatedAt: '2026-07-24T00:00:03.000000Z',
  }),
  Object.freeze({
    id: 'public-a',
    title: 'Public A',
    visibility: 'public',
    ownerSubjectId: OWNER,
    updatedAt: '2026-07-24T00:00:02.000000Z',
  }),
  Object.freeze({
    id: 'protected-owner',
    title: 'Protected Owner',
    visibility: 'protected',
    ownerSubjectId: OWNER,
    updatedAt: '2026-07-24T00:00:01.000000Z',
  }),
  Object.freeze({
    id: 'protected-member',
    title: 'Protected Member',
    visibility: 'protected',
    ownerSubjectId: 'other-owner',
    member: MEMBER,
    updatedAt: '2026-07-24T00:00:00.500000Z',
  }),
  Object.freeze({
    id: 'unlisted',
    title: 'Unlisted',
    visibility: 'unlisted',
    ownerSubjectId: OWNER,
    updatedAt: '2026-07-24T00:00:00.400000Z',
  }),
  Object.freeze({
    id: 'private',
    title: 'Private',
    visibility: 'private',
    ownerSubjectId: OWNER,
    updatedAt: '2026-07-24T00:00:00.300000Z',
  }),
]);

export interface CompatVisibilityProjectionFixture {
  readonly projection: Phase4bMcpCollectionResourceProjection;
  readonly destroy: () => void;
}

export function collectionResourceUri(collectionId: string): string {
  return `colp://${SERVER_UUID}/collections/${collectionId}`;
}

export function listedCollectionIds(response: {
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): string[] {
  const resources = compatJsonRpc(response).result?.resources as
    | readonly { readonly uri?: string }[]
    | undefined;
  return (resources ?? []).map((entry) => entry.uri?.split('/').at(-1) ?? '');
}

export function countProjectionListCalls(
  projection: Phase4bMcpCollectionResourceProjection,
): {
  readonly projection: Phase4bMcpCollectionResourceProjection;
  readonly lists: { count: number };
} {
  const lists = { count: 0 };
  return {
    lists,
    projection: Object.freeze({
      listResources: async (
        input: Parameters<Phase4bMcpCollectionResourceProjection['listResources']>[0],
        context: Parameters<Phase4bMcpCollectionResourceProjection['listResources']>[1],
      ) => {
        lists.count += 1;
        return projection.listResources(input, context);
      },
      readResource: (
        input: Parameters<Phase4bMcpCollectionResourceProjection['readResource']>[0],
        context: Parameters<Phase4bMcpCollectionResourceProjection['readResource']>[1],
      ) => projection.readResource(input, context),
      cacheForList: (
        input: Parameters<Phase4bMcpCollectionResourceProjection['cacheForList']>[0],
        context: Parameters<Phase4bMcpCollectionResourceProjection['cacheForList']>[1],
      ) => projection.cacheForList(input, context),
      cacheForRead: (
        input: Parameters<Phase4bMcpCollectionResourceProjection['cacheForRead']>[0],
        context: Parameters<Phase4bMcpCollectionResourceProjection['cacheForRead']>[1],
      ) => projection.cacheForRead(input, context),
    }),
  };
}

export function createCompatVisibilityProjection(pageSize = 100): CompatVisibilityProjectionFixture {
  const members: Record<string, readonly string[]> = { [MEMBER]: ['protected-member'] };
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'compat-pub', secret: Buffer.alloc(32, 41).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'compat-mcp', secret: Buffer.alloc(32, 43).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const directory = fixtureCollections
    .filter((fixture) => fixture.visibility === 'public' || fixture.visibility === 'protected')
    .map((fixture, index) => ({
      id: fixture.id,
      ownerSubjectId: fixture.ownerSubjectId,
      title: fixture.title,
      summary: null,
      kind: 'bookmarks' as const,
      visibility: fixture.visibility === 'public' ? 'public' as const : 'protected' as const,
      publicationSlug: fixture.id,
      tags: [] as string[],
      language: null,
      nodeCount: 1,
      updatedAt: fixture.updatedAt,
      orderingUpdatedAtMicros: String(3_000_000 - index * 100_000),
      protectedAuthorized: fixture.visibility === 'protected',
    }));
  const projection = createPhase4bMcpCollectionResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    directoryQuery: {
      reads: {
        async loadPage(request) {
          const subject = request.principal === 'anonymous' ? undefined : request.principal.subjectId;
          const visible = directory.filter((record) => {
            if (request.principal === 'anonymous') return record.visibility === 'public';
            if (record.visibility === 'public') return true;
            if (record.visibility !== 'protected') return false;
            return record.ownerSubjectId === subject
              || (subject !== undefined && (members[subject] ?? []).includes(record.id));
          });
          const sorted = [...visible].sort((left, right) => {
            const time = Number(right.orderingUpdatedAtMicros) - Number(left.orderingUpdatedAtMicros);
            if (time !== 0) return time;
            return left.id.localeCompare(right.id, 'en', { sensitivity: 'variant' });
          });
          let page = sorted;
          if (request.after !== undefined) {
            const anchor = sorted.find((record) =>
              createHash('sha256').update(record.id).digest('hex').slice(0, 32)
                === request.after!.idLocator);
            const anchorIndex = anchor === undefined ? -1 : sorted.indexOf(anchor);
            if (anchorIndex < 0) throw new Error('publication directory anchor missing');
            page = sorted.slice(anchorIndex + 1);
          }
          return Object.freeze(page.slice(0, request.limit + 1));
        },
      },
      cursors: publicationCursors,
      origin: 'https://known.example',
    },
    metadataQuery: {
      reads: {
        async load(input) {
          const key = input.collectionId ?? input.publicationSlug;
          const fixture = fixtureCollections.find((candidate) => candidate.id === key);
          if (fixture === undefined) return null;
          return {
            id: fixture.id,
            ownerSubjectId: fixture.ownerSubjectId,
            kind: 'bookmarks' as const,
            title: fixture.title,
            summary: null,
            visibility: fixture.visibility,
            publicationSlug: fixture.id,
            rootNodeId: `${fixture.id}-root`,
            rootAvailable: true,
            contentRevision: 'content-1',
            policyRevision: 'policy-1',
            tags: [] as string[],
            language: null,
            membershipRole: fixture.id === 'protected-member' && input.actorSubjectId === MEMBER
              ? 'viewer'
              : null,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: fixture.updatedAt,
            deletedAt: null,
          };
        },
      },
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: {
      async loadCollectionFacts(input) {
        const fixture = fixtureCollections.find((candidate) => candidate.id === input.collectionId);
        if (fixture === undefined) return null;
        return {
          collectionId: fixture.id,
          ownerSubjectId: fixture.ownerSubjectId,
          visibility: fixture.visibility,
          policyRevision: 'policy-1',
          membershipRole: fixture.member === input.actorSubjectId ? 'viewer' : null,
          deleted: false,
        };
      },
    } as AccessPolicyFactsPort,
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize,
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  });
  return {
    projection,
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

export async function signedCompatVisibilityClient() {
  const key = await createKeyFixture('compat-t05');
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
    audience: [AUDIENCE, `${AUDIENCE}-compat`],
    now: () => NOW,
    clockToleranceSeconds: 0,
  }));
  return { key, verifier };
}

export function mintVisibilityToken(
  key: Awaited<ReturnType<typeof createKeyFixture>>,
  subject: string,
  jti: string,
): Promise<string> {
  return mintCredential({
    key: key.privateKey,
    kid: key.kid,
    subject,
    jti,
    audience: `${AUDIENCE}-compat`,
  });
}
