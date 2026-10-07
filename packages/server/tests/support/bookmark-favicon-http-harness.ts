/**
 * Shared in-memory Fastify harness for BF-03 bookmark favicon HTTP tests.
 */
import { createHash } from 'node:crypto';
import { loadConfig } from './test-config.js';
import type {
  AccessPolicyFactsPort,
  AccessPolicyWritePort,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../src/modules/access-policy/index.js';
import { canonicalCommandFingerprint } from '../../src/modules/commands/index.js';
import {
  createProductOwnedCollectionsCursorSigner,
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type ChildrenRevisionInsert,
  type CollectionBootstrapRow,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type ContentRevisionInsert,
  type FaviconSourceRestoreRow,
  type FaviconSourceRestoreWritePort,
  type IdLedgerReserveEntry,
  type LockedCollectionRow,
  type LockedNodeRow,
  type NodeInsertRow,
  type NodeSoftDeleteRow,
  type PolicyRevisionInsert,
  type ResourceRevisionInsert,
  type RootNodeBootstrapRow,
  type SiblingPositionRow,
} from '../../src/modules/collections/index.js';
import { ExtensionAuthError } from '../../src/modules/identity/index.js';
import type { ExtensionCredentialEvidencePort } from '../../src/modules/identity/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { createMemoryProductCollectionMutationUnitOfWork } from './product-canonical-memory.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from './better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryPorts,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  executeMemoryTransaction,
  productCommandReceiptKey,
  type MemoryProductCommandReceipts,
} from './product-http-harness.js';

export const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
export const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
export const COMMAND_C = 'c0ffee00-6271-4fdf-a946-d22e58a99c2a';
export const NOW = new Date('2026-07-22T12:00:00.000Z');
export const COLLECTION_ID = 'col-favicon-http-1';
export const OTHER_COLLECTION_ID = 'col-favicon-http-other';
export const ROOT_ID = 'root-favicon-http-1';
export const FOLDER_ID = 'folder-favicon-http-1';
export const BOOKMARK_ID = 'bookmark-favicon-http-1';
export const BOOKMARK_B_ID = 'bookmark-favicon-http-2';
export const BOOKMARK_REV = 'bookmark-res-1';
export const FOLDER_REV = 'folder-res-1';
export const CONTENT_REV = 'content-favicon-1';
export const POLICY_REV = 'policy-favicon-1';
export const RESOURCE_REV = 'resource-favicon-1';
export const ROOT_CHILDREN_REV = 'children-favicon-root-1';
export const PRODUCT_ORIGIN = 'https://app.example.test';
export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const OWNER_BEARER = 'owner-favicon-bearer';
export const EDITOR_BEARER = 'editor-favicon-bearer';

export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);
export const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00]);
export const CUR = Buffer.from([0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00]);
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

export type NodeVisibility = 'inherit' | 'protected' | 'private';
export type ApiApp = ReturnType<typeof buildApiApp>;

export interface MembershipRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}

export interface MutableCollection extends LockedCollectionRow {}

export interface MutableNode {
  id: string;
  collectionId: string;
  kind: 'folder' | 'bookmark';
  isRoot: boolean;
  parentId: string | null;
  positionToken: string | null;
  title: string;
  url: string | null;
  description: string | null;
  tags: string[];
  visibility: NodeVisibility;
  resourceRevision: string;
  childrenRevision: string;
  deletedAt: Date | null;
  deletedCommitOrdinal?: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookmarkIconRow {
  nodeId: string;
  collectionId: string;
  objectId: string;
  contentType: string;
  byteSize: number;
  digestSha256: Buffer;
  createdAt: Date;
  updatedAt: Date;
}

export interface CollectionsMemoryState {
  now: Date;
  receipts: MemoryProductCommandReceipts;
  ledger: IdLedgerReserveEntry[];
  bootstrapCollections: CollectionBootstrapRow[];
  collections: Map<string, MutableCollection>;
  nodes: Map<string, MutableNode>;
  bookmarkIcons: Map<string, BookmarkIconRow>;
  /** FO-07 durable retirement ledger: objectId -> {nodeId, collectionId, retiredAt, deletableAt}. */
  faviconPendingDeletions: Map<string, {
    nodeId: string; collectionId: string; retiredAt: Date; deletableAt: Date;
  }>;
  /** F-A8 pending force-restore rows by nodeId; empty unless a test seeds one. */
  faviconRestores: Map<string, FaviconSourceRestoreRow>;
  rootBootstrap: RootNodeBootstrapRow[];
  memberships: MembershipRow[];
  policies: Map<string, { collectionId: string; policyJson: Readonly<Record<string, unknown>>; updatedAt: Date }>;
  resourceRevisions: ResourceRevisionInsert[];
  contentRevisions: ContentRevisionInsert[];
  policyRevisions: PolicyRevisionInsert[];
  childrenRevisions: ChildrenRevisionInsert[];
  operations: BootstrapOperationRecord[];
  audit: BootstrapAuditRecord[];
  outbox: BootstrapOutboxRecord[];
}

export interface MemoryFaviconStore {
  readonly objects: Map<string, { contentType: string; body: Buffer }>;
  readonly puts: string[];
  readonly deletes: string[];
  deleteFails: boolean;
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string): Promise<{ contentType: string; body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
}

export function createMemoryFaviconStore(): MemoryFaviconStore {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  const puts: string[] = [];
  const deletes: string[] = [];
  const store: MemoryFaviconStore = {
    objects,
    puts,
    deletes,
    deleteFails: false,
    async put(objectId, body, contentType) {
      puts.push(objectId);
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      const row = objects.get(objectId);
      return row ? { contentType: row.contentType, body: Buffer.from(row.body) } : null;
    },
    async delete(objectId) {
      deletes.push(objectId);
      if (store.deleteFails) throw new Error('injected r2 delete failure');
      objects.delete(objectId);
    },
  };
  return store;
}

export function toLockedNode(row: MutableNode): LockedNodeRow {
  return {
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    kind: row.kind,
    isRoot: row.isRoot,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: [...row.tags],
    visibility: row.visibility,
    positionToken: row.positionToken,
    resourceRevision: row.resourceRevision,
    childrenRevision: row.childrenRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function createCollectionsWritePorts(state: CollectionsMemoryState): CollectionsWritePorts {
  return {
    receipts: createMemoryProductCommandReceiptPort(state.receipts),
    clock: { now: async () => new Date(state.now) },
    idLedger: {
      async reserve(entries: readonly IdLedgerReserveEntry[]) {
        for (const entry of entries) {
          if (state.ledger.some((e) => e.resourceId === entry.resourceId)) {
            throw new Error(`duplicate ledger id ${entry.resourceId}`);
          }
          state.ledger.push({ ...entry });
        }
      },
    },
    collections: {
      async insertBootstrap(row) {
        state.bootstrapCollections.push({ ...row });
      },
      async lockForUpdate(collectionId) {
        const row = state.collections.get(collectionId);
        return row ? { ...row } : null;
      },
      async lockForShare(collectionId) {
        return this.lockForUpdate(collectionId);
      },
      async advanceContentFence(collectionId, update) {
        const row = state.collections.get(collectionId);
        if (!row) throw new Error('missing collection');
        row.contentRevision = update.contentRevision;
        row.commitOrdinal = update.commitOrdinal;
        row.updatedAt = update.updatedAt;
        if (update.policyRevision !== undefined) row.policyRevision = update.policyRevision;
      },
    },
    nodes: {
      async insertRoot(row: RootNodeBootstrapRow) {
        state.rootBootstrap.push({ ...row });
      },
      async insertNode(row: NodeInsertRow) {
        if (state.nodes.has(row.id)) throw new Error(`duplicate node ${row.id}`);
        state.nodes.set(row.id, {
          id: row.id,
          collectionId: row.collectionId,
          parentId: row.parentId,
          kind: row.kind,
          isRoot: false,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: [...row.tags],
          visibility: row.visibility,
          positionToken: row.positionToken,
          resourceRevision: row.resourceRevision,
          childrenRevision: row.childrenRevision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt: null,
        });
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) return null;
        return toLockedNode(row);
      },
      async listLiveSiblingPositions(collectionId, parentId): Promise<readonly SiblingPositionRow[]> {
        return [...state.nodes.values()]
          .filter((n) => n.collectionId === collectionId && n.parentId === parentId
            && n.deletedAt === null && n.positionToken !== null)
          .sort((a, b) => (a.positionToken! < b.positionToken! ? -1 : a.positionToken! > b.positionToken! ? 1 : 0))
          .map((n) => ({ id: n.id, positionToken: n.positionToken! }));
      },
      async updateContent(collectionId, nodeId, update) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) throw new Error(`missing node ${nodeId}`);
        row.title = update.title;
        row.url = update.url;
        row.description = update.description;
        row.tags = [...update.tags];
        row.visibility = update.visibility;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updatePosition(collectionId, nodeId, update) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) throw new Error(`missing node ${nodeId}`);
        row.positionToken = update.positionToken;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updateParentAndPosition(collectionId, nodeId, update) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) throw new Error(`missing node ${nodeId}`);
        row.parentId = update.parentId;
        row.positionToken = update.positionToken;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async advanceChildrenRevision(collectionId, nodeId, childrenRevision, updatedAt) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) throw new Error(`missing parent ${nodeId}`);
        row.childrenRevision = childrenRevision;
        row.updatedAt = updatedAt;
      },
      async markDeleted(collectionId, nodeId, update: NodeSoftDeleteRow) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) throw new Error(`missing node ${nodeId}`);
        row.deletedAt = update.deletedAt;
        row.deletedCommitOrdinal = update.deletedCommitOrdinal;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
        state.bookmarkIcons.delete(nodeId);
      },
    },
    revisions: {
      async insertResourceRevision(row) { state.resourceRevisions.push({ ...row }); },
      async insertContentRevision(row) { state.contentRevisions.push({ ...row }); },
      async insertPolicyRevision(row) { state.policyRevisions.push({ ...row }); },
      async insertChildrenRevision(row) { state.childrenRevisions.push({ ...row }); },
    },
    operations: { async append(record) { state.operations.push({ ...record }); } },
    audit: { async append(record) { state.audit.push({ ...record }); } },
    outbox: { async append(record) { state.outbox.push({ ...record }); } },
    accessPolicy: {
      async insertMembership(input) {
        state.memberships.push({
          collectionId: input.collectionId,
          subjectId: input.subjectId,
          role: input.role,
          grantedAt: input.grantedAt,
        });
      },
      async deleteMembership(input) {
        state.memberships = state.memberships.filter(
          (m) => !(m.collectionId === input.collectionId && m.subjectId === input.subjectId),
        );
        return true;
      },
      async upsertCollectionPolicy(input) {
        state.policies.set(input.collectionId, {
          collectionId: input.collectionId,
          policyJson: input.policyJson ?? {},
          updatedAt: input.updatedAt,
        });
      },
    } satisfies AccessPolicyWritePort,
    accessPolicyFacts: {
      async loadCollectionFacts(input): Promise<ResourcePolicyFacts | null> {
        const collection = state.collections.get(input.collectionId);
        if (!collection) return null;
        const membership = state.memberships.find(
          (m) => m.collectionId === input.collectionId && m.subjectId === input.actorSubjectId,
        );
        return {
          collectionId: collection.id,
          ownerSubjectId: collection.ownerSubjectId,
          visibility: collection.visibility,
          policyRevision: collection.policyRevision,
          membershipRole: membership?.role ?? null,
          deleted: collection.deletedAt !== null,
        };
      },
    } satisfies AccessPolicyFactsPort,
    bookmarkIcons: {
      async findByNodeId(nodeId: string) {
        return state.bookmarkIcons.get(nodeId) ?? null;
      },
      async findObjectIdsByNodeIds(nodeIds: readonly string[]) {
        const result = new Map<string, string>();
        if (nodeIds.length === 0) return result;
        for (const id of nodeIds) {
          const row = state.bookmarkIcons.get(id);
          if (row) result.set(id, row.objectId);
        }
        return result;
      },
      async upsert(row: BookmarkIconRow) {
        state.bookmarkIcons.set(row.nodeId, { ...row, digestSha256: Buffer.from(row.digestSha256) });
      },
      async deleteByNodeId(nodeId: string) {
        const existing = state.bookmarkIcons.get(nodeId) ?? null;
        state.bookmarkIcons.delete(nodeId);
        return existing;
      },
      async deleteByNodeIds(nodeIds: readonly string[]) {
        for (const id of nodeIds) state.bookmarkIcons.delete(id);
      },
      async deleteByCollectionId(collectionId: string) {
        for (const [nodeId, row] of state.bookmarkIcons) {
          if (row.collectionId === collectionId) state.bookmarkIcons.delete(nodeId);
        }
      },
    } satisfies BookmarkIconWritePort,
    // FO-04 helper surface: account policy defaults to the virtual revision 1
    // (no stored row) and every node starts at the virtual inherit source
    // revision 1, so helper capture uses etag "favicon-source:<rev>:1" and
    // policy revision "1" unless a test seeds a row.
    faviconPolicies: {
      async findByAccountId() { return null; },
      async update() {
        return { kind: 'updated' as const, row: {
          accountId: 'memory-account', newDefault: 'capture' as const,
          providerTemplate: 'https://favicone.com/{hostname}', fillMissing: false,
          forceAllOnline: false, revision: 2n, updatedAt: new Date(state.now),
        } };
      },
    } satisfies CollectionsWritePorts['faviconPolicies'],
    faviconSources: {
      async findByNodeId() { return null; },
      async update(input) {
        return { kind: 'updated' as const, row: {
          nodeId: input.nodeId, collectionId: input.collectionId,
          sourceMode: input.sourceMode, revision: 2n, updatedAt: input.updatedAt,
        } };
      },
      async setMode() {},
    } satisfies CollectionsWritePorts['faviconSources'],
    faviconGc: {
      async recordRetired(input) {
        state.faviconPendingDeletions.set(input.objectId, {
          nodeId: input.nodeId,
          collectionId: input.collectionId,
          retiredAt: input.retiredAt,
          deletableAt: input.deletableAt,
        });
      },
    } satisfies CollectionsWritePorts['faviconGc'],
    // F-A8: pending force-restore ledger. Insert-only first-writer-wins like
    // the Postgres adapter (`on conflict do nothing`). Not declared on
    // CollectionsWritePorts — the helper gate narrows it like the real
    // adapter's faviconRestores spread does.
    faviconRestores: {
      async findByNodeId(nodeId: string) {
        return state.faviconRestores.get(nodeId) ?? null;
      },
      async upsert(row) {
        if (!state.faviconRestores.has(row.nodeId)) {
          state.faviconRestores.set(row.nodeId, { ...row });
        }
      },
      async deleteByNodeId(nodeId: string) {
        state.faviconRestores.delete(nodeId);
      },
    } satisfies FaviconSourceRestoreWritePort,
  } as CollectionsWritePorts;
}

export interface Harness {
  readonly app: ApiApp;
  readonly config: ReturnType<typeof loadConfig>;
  readonly collectionsState: CollectionsMemoryState;
  readonly faviconStore: MemoryFaviconStore;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly extensionSubjects: Record<string, string>;
}

export interface AuthedClient {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly subjectId: string;
  readonly accountId: string;
}

export function createVerifier(tokens: Readonly<Record<string, string>>): ExtensionCredentialEvidencePort {
  return {
    async verify(input) {
      const raw = typeof input.authorization === 'string' ? input.authorization : '';
      if (!raw.startsWith('Bearer ')) {
        throw new ExtensionAuthError('invalid_authorization_header');
      }
      const token = raw.slice('Bearer '.length);
      const subject = tokens[token];
      if (!subject) throw new ExtensionAuthError('invalid_token');
      return {
        kind: 'verified_extension_credential',
        issuer: PRODUCT_ORIGIN,
        subject,
        audience: 'known-sync-api',
        clientId: 'known-chromium-extension',
        scopes: Object.freeze(['known.sync']),
        credentialId: `cred-${subject}`,
        credentialDigest: 'digest',
        credentialIssuedAt: NOW,
        credentialExpiresAt: new Date(NOW.getTime() + 86_400_000),
        verifiedAt: NOW,
        evidenceExpiresAt: new Date(NOW.getTime() + 60_000),
      } as Awaited<ReturnType<ExtensionCredentialEvidencePort['verify']>>;
    },
  };
}

export function createHarness(options: {
  readonly omitFaviconStore?: boolean;
} = {}): Harness {
  const identityState = createIdentityMemoryState(NOW);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  createIdentityMemoryPorts(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const extensionSubjects: Record<string, string> = {};
  const collectionsState: CollectionsMemoryState = {
    now: new Date(NOW),
    receipts: new Map(),
    ledger: [],
    bootstrapCollections: [],
    collections: new Map(),
    nodes: new Map(),
    bookmarkIcons: new Map(),
    faviconPendingDeletions: new Map(),
    faviconRestores: new Map(),
    rootBootstrap: [],
    memberships: [],
    policies: new Map(),
    resourceRevisions: [],
    contentRevisions: [],
    policyRevisions: [],
    childrenRevisions: [],
    operations: [],
    audit: [],
    outbox: [],
  };
  const collectionsUnitOfWork: CollectionsUnitOfWork = {
    execute: (work) => executeMemoryTransaction(
      collectionsState,
      (transaction) => work(createCollectionsWritePorts(transaction)),
    ),
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN,
    ALLOWED_ORIGINS: PRODUCT_ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${PRODUCT_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SYNC_EXTENSION_IDS: EXTENSION_ID,
    // FO-04: the helper surface is gated by the same flag as the Product
    // favicon policy/source surface; the memory harness runs flag-on.
    KNOWN_FEATURE_FAVICON_POLICY: 'true',
    // FO-05: the children cursor HMAC key is required when the flag is on.
    FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 42).toString('base64url'),
  });
  const faviconStore = createMemoryFaviconStore();
  const app = buildApiApp({
    collectionMetadataMutationRoutes: 'disabled',
    config,
    identityUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork:
      createMemoryProductCollectionMutationUnitOfWork(collectionsUnitOfWork, {
        productOrigin: PRODUCT_ORIGIN,
      }),
    browserSessionAuthority: factory.authority,
    ...(options.omitFaviconStore ? {} : { faviconStore }),
    extensionCollectionRoutes: {
      credentialVerifier: createVerifier(extensionSubjects),
      // Memory verifier subjects are account subject ids. Registration in
      // extensionSubjects is the identity binding the helper now requires.
      ownerSubject: {
        async resolveOwnerSubject(identity: { readonly issuer: string; readonly subject: string }) {
          if (identity.issuer !== PRODUCT_ORIGIN) return null;
          return Object.values(extensionSubjects).includes(identity.subject) ? identity.subject : null;
        },
      },
      allowedOrigins: [EXTENSION_ORIGIN],
      ownedCollectionsQuery: {
        reads: { async listOwnedCollections() { return []; } },
        cursors: createProductOwnedCollectionsCursorSigner({
          current: { id: 'fav-ext-v1', key: 'favicon-ext-cursor-secret-material-32b' },
        }),
        clock: { now: async () => NOW },
      },
    },
  });
  return { app, config, collectionsState, faviconStore, factory, extensionSubjects };
}

export function seedCollection(
  harness: Harness,
  options: {
    ownerSubjectId: string;
    collectionId?: string;
    rootId?: string;
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
  },
): void {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const rootId = options.rootId ?? ROOT_ID;
  const createdAt = new Date(harness.collectionsState.now);
  harness.collectionsState.collections.set(collectionId, {
    id: collectionId,
    ownerSubjectId: options.ownerSubjectId,
    title: 'Favicon HTTP',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: rootId,
    resourceRevision: RESOURCE_REV,
    contentRevision: CONTENT_REV,
    policyRevision: POLICY_REV,
    commitOrdinal: 1n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  harness.collectionsState.memberships.push({
    collectionId,
    subjectId: options.ownerSubjectId,
    role: 'owner',
    grantedAt: createdAt,
  });
  for (const m of options.memberships ?? []) {
    harness.collectionsState.memberships.push({
      collectionId,
      subjectId: m.subjectId,
      role: m.role,
      grantedAt: createdAt,
    });
  }
  harness.collectionsState.nodes.set(rootId, {
    id: rootId,
    collectionId,
    kind: 'folder',
    isRoot: true,
    parentId: null,
    positionToken: null,
    title: 'Root',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    resourceRevision: 'root-res-1',
    childrenRevision: ROOT_CHILDREN_REV,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function seedBookmark(
  harness: Harness,
  options: {
    id?: string;
    parentId?: string;
    collectionId?: string;
    revision?: string;
    positionToken?: string;
  } = {},
): void {
  const createdAt = new Date(harness.collectionsState.now);
  const id = options.id ?? BOOKMARK_ID;
  harness.collectionsState.nodes.set(id, {
    id,
    collectionId: options.collectionId ?? COLLECTION_ID,
    kind: 'bookmark',
    isRoot: false,
    parentId: options.parentId ?? ROOT_ID,
    positionToken: options.positionToken ?? 'A',
    title: 'Favicon bookmark',
    url: 'https://example.test/page',
    description: null,
    tags: [],
    visibility: 'inherit',
    resourceRevision: options.revision ?? BOOKMARK_REV,
    childrenRevision: 'ch-bm-1',
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function seedFolder(harness: Harness): void {
  const createdAt = new Date(harness.collectionsState.now);
  harness.collectionsState.nodes.set(FOLDER_ID, {
    id: FOLDER_ID,
    collectionId: COLLECTION_ID,
    kind: 'folder',
    isRoot: false,
    parentId: ROOT_ID,
    positionToken: 'F',
    title: 'Folder',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    resourceRevision: FOLDER_REV,
    childrenRevision: 'ch-folder-1',
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function productFaviconUrl(collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon`;
}

export function helperFaviconUrl(collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return `/colp/v0.1/sync/collections/${collectionId}/nodes/${nodeId}/favicon`;
}

/** FO-04 virtual-source ETag for a fresh bookmark: source virtual revision 1. */
export function helperSourceEtag(nodeResourceRevision = BOOKMARK_REV): string {
  return `"favicon-source:${nodeResourceRevision}:1"`;
}

/** FO-04 virtual-policy revision before any stored account policy row. */
export const HELPER_POLICY_REVISION = '1';

export function helperCaptureFingerprint(body: Buffer, mediaType: string,
  collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/colp/v0.1/sync/collections/${collectionId}/nodes/${nodeId}/favicon`,
    mediaType,
    body: createHash('sha256').update(body).digest('hex'),
  });
}

export function helperClearFingerprint(collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return canonicalCommandFingerprint({
    method: 'DELETE',
    route: `/colp/v0.1/sync/collections/${collectionId}/nodes/${nodeId}/favicon`,
    mediaType: '',
    body: '',
  });
}

export function productRoute(collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return `/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon`;
}

export function uploadFingerprint(body: Buffer, mediaType: string, collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: productRoute(collectionId, nodeId),
    mediaType,
    body: createHash('sha256').update(body).digest('hex'),
  });
}

export function deleteFingerprint(collectionId = COLLECTION_ID, nodeId = BOOKMARK_ID): string {
  return canonicalCommandFingerprint({
    method: 'DELETE',
    route: productRoute(collectionId, nodeId),
    mediaType: '',
    body: '',
  });
}

export function sessionHeaders(
  harness: Harness,
  client: AuthedClient,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: harness.config.productOrigin,
    'x-csrf-token': client.csrfToken,
    ...extra,
  };
}

export const faviconHttpApps: ApiApp[] = [];

export async function closeFaviconHttpApps(): Promise<void> {
  while (faviconHttpApps.length > 0) await faviconHttpApps.pop()?.close();
}

export async function issueOwned(harness: Harness, subject: string, handle: string): Promise<AuthedClient> {
  const client = await issueTestSession({
    factory: harness.factory,
    subject,
    displayName: subject,
    handle,
  });
  return {
    cookie: client.cookie,
    csrfToken: client.csrfToken,
    subjectId: client.subjectId,
    accountId: client.accountId,
  };
}
