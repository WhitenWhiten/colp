/** Type-checked protocol examples; not an executable adapter or runtime test. */
import type {
  AdapterManifest, BrowserSiteRuleExtension, MountBinding, SavePolicy, SiteObservation, SourcePage, CollectionItem,
  BootstrapRequest, HostCommand, AdapterMessage, SavePlan,
} from './contracts.js';

export const manifest = {
  apiVersion: 'known.site-adapter/v1',
  adapterId: 'known.bilibili',
  version: '0.1.0',
  siteKey: 'bilibili',
  identityVersion: 1,
  matches: ['https://www.bilibili.com/*', 'https://space.bilibili.com/*'],
  execution: { mode: 'bundled', entry: 'bilibili.js', runAt: 'document_idle' },
  capabilities: ['observeFavorites', 'enumerateCollections', 'enumerateItems', 'mountCaptureControl'],
} satisfies AdapterManifest;

export const collections = {
  type: 'catalog.upsert',
  collections: [
    { id: 'folder:101', identity: 'siteId', title: 'A', parentId: null },
    { id: 'folder:102', identity: 'siteId', title: 'B', parentId: null },
    { id: 'folder:103', identity: 'siteId', title: 'C', parentId: null },
  ],
} satisfies SiteObservation;

// Synthetic IDs and a reserved example URL; protocol-shape examples only.
// A Bilibili host grant would reject this URL. These are not signed-in site fixtures.
export const addToB = {
  type: 'favorite.confirmed',
  interactionId: 'interaction:1',
  item: { id: 'video:1', identity: 'siteId', kind: 'video', url: 'https://example.com/video/1', title: 'Video1' },
  memberships: { mode: 'delta', added: ['folder:102'], removed: [] },
  confirmation: { kind: 'settledDom', detector: 'fixture.confirmed-membership' },
} satisfies SiteObservation;

export const alsoAddToC = {
  ...addToB,
  interactionId: 'interaction:2',
  memberships: { mode: 'delta', added: ['folder:103'], removed: [] },
} satisfies SiteObservation;

// B alone was observed. This is NOT a complete snapshot and does not remove C.
export const readVisibleB = {
  type: 'membership.observed',
  item: addToB.item,
  memberships: { mode: 'delta', added: ['folder:102'], removed: [] },
} satisfies SiteObservation;

export const siteRuleExtension = {
  version: 1,
  admission: {
    entries: ['siteFavorite', 'siteImport', 'reconcile'],
    purpose: 'sourceArchive',
    connectionId: 'connection:local-bilibili-self',
  },
  layout: { kind: 'sourceCollections', rootRole: 'destination' },
} satisfies BrowserSiteRuleExtension;

// The associated BrowserRule still contains its existing RuleDefinition and
// folderNativeId binding. Its import-enabled variant explicitly sets
// definition.policy.imports = 'include' after the user's import preview.
export const mount = {
  id: 'mount:1',
  connectionId: 'connection:local-bilibili-self',
  rootRuleId: 'browser-rule:1',
  root: {
    bindingId: 'binding:root:1', deviceId: 'device:local', nativeId: 'native-bilibili-root', kind: 'folder',
    dateAdded: 1700000000000, proof: { kind: 'explicitAdoption', id: 'root-selection:1' },
  },
  revision: 1,
  aiDestination: 'excluded',
} satisfies MountBinding;

export const keepBoth = {
  revision: 1,
  copies: 'sourceAndSemantic',
  backgroundClassification: 'disabled',
  sourceRemoval: 'retainArchive',
} satisfies SavePolicy;

export const semanticWins = {
  revision: 2,
  copies: 'singlePreferSemantic',
  primarySourceCollectionId: 'folder:102',
  backgroundClassification: 'disabled',
  sourceRemoval: 'retainArchive',
} satisfies SavePolicy;

export const lastPageOfB = {
  items: [{ item: addToB.item }],
  nextCursor: null,
  coverage: 'complete',
  consistency: 'bestEffort',
} satisfies SourcePage<CollectionItem>;

// A bundled hello is admitted only on the dedicated, browser-validated channel.
// The claimed account still has to match an explicitly connected source.
export const hello = {
  protocolVersion: 1, operation: 'hello', runtime: 'bundled', adapterId: 'known.bilibili',
  source: { state: 'signedIn', accountId: 'fixture-account' },
} satisfies BootstrapRequest;

export const readB = {
  operation: 'readPage', leaseId: 'fixture-lease', readSessionId: 'read:1', pageRequestId: 'page:B:1',
  deadlineAt: 1700000030000, query: { kind: 'items', collectionId: 'folder:102', cursor: null },
} satisfies HostCommand;

// Tokens below are inert fixture values, never actual bootstrap credentials.
export const readBReply = {
  protocolVersion: 1, operation: 'page.result', requestId: 'reply:B:1',
  leaseId: 'fixture-lease', capability: 'fixture-only', readSessionId: 'read:1', pageRequestId: 'page:B:1',
  result: { status: 'ok', kind: 'items', collectionId: 'folder:102', page: lastPageOfB },
} satisfies AdapterMessage;

// Internal host fixture. No folder ID exists for B until its receipt is proven.
export const archivePlan = {
  id: 'plan:1', trigger: { kind: 'observation', observationId: 'observation:1' },
  purpose: 'sourceArchive', connectionId: mount.connectionId,
  installationGeneration: 1, collectorGeneration: 1, sourceSessionGeneration: 1,
  rule: { id: mount.rootRuleId, revision: 'fixture-rule-revision' },
  mount: { id: mount.id, revision: mount.revision }, policyRevision: keepBoth.revision,
  classificationPolicyDigest: 'fixture-policy-digest', classification: 'disabled',
  effects: [
    {
      kind: 'ensureSourceFolder', effectId: 'effect:folder:B', commandId: 'command:folder:B',
      payloadDigest: 'fixture-folder-digest', dependsOn: [], mountId: mount.id, collectionId: 'folder:102',
      parent: { kind: 'native', binding: mount.root }, title: 'B',
    },
    {
      kind: 'createBookmark', effectId: 'effect:bookmark:1:B', commandId: 'command:bookmark:1:B',
      payloadDigest: 'fixture-bookmark-digest', dependsOn: ['effect:folder:B'],
      representation: {
        connectionId: mount.connectionId, itemId: addToB.item.id, purpose: 'sourceArchive',
        sourceCollectionId: 'folder:102', mountId: mount.id,
      },
      item: addToB.item, parent: { kind: 'planned', folderEffectId: 'effect:folder:B' },
    },
  ],
} satisfies SavePlan;

// Expected outcomes for a future planner fixture. These paths are presentation
// only; actual effects bind native IDs and never execute a textual path.
export const acceptanceExamples = [
  {
    sequence: ['addToB', 'popupSemanticSave'],
    policy: keepBoth,
    expectedPaths: ['/root/videos/bilibili/B/Video1', '/root/servers/network-configuration/Video1'],
  },
  {
    sequence: ['popupSemanticSave', 'addToB'],
    policy: keepBoth,
    expectedPaths: ['/root/videos/bilibili/B/Video1', '/root/servers/network-configuration/Video1'],
  },
  {
    sequence: ['addToB', 'popupSemanticSave', 'importBAgain'],
    policy: semanticWins,
    expectedPaths: ['/root/servers/network-configuration/Video1'],
  },
  {
    sequence: ['addToB', 'alsoAddToC', 'readVisibleB'],
    policy: keepBoth,
    expectedPaths: ['/root/videos/bilibili/B/Video1', '/root/videos/bilibili/C/Video1'],
  },
] as const;
