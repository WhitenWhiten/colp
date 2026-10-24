/** Type-checked protocol examples; not an executable adapter or runtime test. */
import type {
  AdapterManifest, BrowserSiteRuleExtension, MountBinding, SavePolicy, SiteObservation, SourcePage, CollectionItem,
  BootstrapRequest, HostCommand, AdapterMessage, SavePlan,
  BrowserRuleSnapshot, CaptureContentBinding, SourceFolderReservation, FolderReservationConsumer,
  MembershipReadRequest, ImportPreview, ImportApproval,
} from './contracts.js';

export const manifest = {
  apiVersion: 'known.site-adapter/v1',
  adapterId: 'known.bilibili',
  version: '0.1.0',
  siteKey: 'bilibili',
  identityVersion: 1,
  // Start with the observed page origin; additional origins need separate evidence.
  matches: ['https://www.bilibili.com/*'],
  // The audited MAIN probe is registered separately at document_start.
  execution: { mode: 'bundled', entry: 'bilibili.js', runAt: 'document_idle' },
  capabilities: ['observeFavorites', 'resolveItem', 'readMemberships', 'enumerateCollections', 'enumerateItems', 'mountCaptureControl'],
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
  layout: { kind: 'sourceCollections', root: 'actionDestination' },
} satisfies BrowserSiteRuleExtension;

export const ruleForB = {
  ...siteRuleExtension,
  admission: { ...siteRuleExtension.admission, collectionIds: ['folder:102'] },
} satisfies BrowserSiteRuleExtension;

export const ruleForC = {
  ...siteRuleExtension,
  admission: { ...siteRuleExtension.admission, collectionIds: ['folder:103'] },
} satisfies BrowserSiteRuleExtension;

// LocalRule in the proposed v3 list retains RuleDefinition and action; a file
// action resolves its direct folderNativeId or its local set's role binding.
// Import admission also requires definition.policy.imports = 'include'.
// That rule setting alone does not approve any import preview.
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

export const browserRules = {
  storageVersion: 3, listRevision: 7, contentVersions: {},
} satisfies BrowserRuleSnapshot;

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

export const resolvePopupItem = {
  operation: 'resolveItem', leaseId: 'fixture-lease', resolutionId: 'resolution:1',
  url: addToB.item.url, deadlineAt: 1700000030000,
} satisfies HostCommand;

export const resolvedPopupItem = {
  protocolVersion: 1, operation: 'item.result', requestId: 'reply:resolution:1',
  leaseId: 'fixture-lease', capability: 'fixture-only', resolutionId: 'resolution:1',
  result: { status: 'resolved', item: addToB.item },
} satisfies AdapterMessage;

// Host record created with semantic intent before any favorite membership.
// Native proof is attached after the save; later adoption binds the connection.
export const popupContentBinding = {
  id: 'content-binding:1',
  content: { siteKey: manifest.siteKey, identityVersion: manifest.identityVersion, itemId: addToB.item.id },
  captureIntentId: 'semantic-intent:1', purpose: 'semantic', native: null, connectionId: null,
} satisfies CaptureContentBinding;

export const membershipRead = {
  id: 'membership-read:1', readSessionId: 'reconcile:1', connectionId: mount.connectionId,
  collectorGeneration: 1, sourceSessionGeneration: 1, leaseId: 'fixture-lease',
  baselineOrdinal: 42, deadlineAt: 1700000030000,
  query: { itemId: addToB.item.id, collectionIds: ['folder:102', 'folder:103'] },
} satisfies MembershipReadRequest;

export const readMemberships = {
  operation: 'readMemberships', leaseId: membershipRead.leaseId,
  readSessionId: membershipRead.readSessionId, readRequestId: membershipRead.id,
  deadlineAt: membershipRead.deadlineAt, query: membershipRead.query,
} satisfies HostCommand;

export const membershipReadReply = {
  protocolVersion: 1, operation: 'membership.result', requestId: 'reply:membership:1',
  leaseId: 'fixture-lease', capability: 'fixture-only',
  readSessionId: membershipRead.readSessionId, readRequestId: membershipRead.id,
  result: {
    status: 'ok', itemId: addToB.item.id,
    edges: [
      { collectionId: 'folder:102', state: 'absent', evidence: { kind: 'refreshedDom', detector: 'fixture.fresh-membership' } },
      { collectionId: 'folder:103', state: 'unknown', reason: 'inaccessible' },
    ],
  },
} satisfies AdapterMessage;

// Internal host fixture. This is the only native create command for B, even
// when different item plans join it. Reservation alone is not write approval.
export const sharedFolderB = {
  id: 'folder-reservation:B', mountId: mount.id, collectionId: 'folder:102', mountRevision: mount.revision,
  parent: { kind: 'native', binding: mount.root }, title: 'B',
  commandId: 'command:create-folder:B', payloadDigest: 'fixture-folder-digest', state: 'reserved', native: null,
} satisfies SourceFolderReservation;

export const archivePlan = {
  id: 'plan:1', trigger: { kind: 'observation', observationId: 'observation:1' },
  purpose: 'sourceArchive', connectionId: mount.connectionId,
  installationGeneration: 1, collectorGeneration: 1, sourceSessionGeneration: 1,
  importApprovalId: null, browserRules,
  rule: { source: 'browser', entry: { kind: 'rule', ruleId: mount.rootRuleId }, definitionDigest: 'fixture-rule-digest' },
  mount: { id: mount.id, revision: mount.revision }, policyRevision: keepBoth.revision,
  classificationPolicyDigest: 'fixture-policy-digest', classification: 'disabled',
  effects: [
    {
      kind: 'ensureSourceFolder', effectId: 'effect:folder-consumer:1:B', commandId: 'command:folder-consumer:1:B',
      payloadDigest: 'fixture-consumer-1-digest', dependsOn: [], reservationId: sharedFolderB.id,
    },
    {
      kind: 'createBookmark', effectId: 'effect:bookmark:1:B', commandId: 'command:bookmark:1:B',
      payloadDigest: 'fixture-bookmark-digest', dependsOn: ['effect:folder-consumer:1:B'],
      representation: {
        connectionId: mount.connectionId, itemId: addToB.item.id, purpose: 'sourceArchive',
        sourceCollectionId: 'folder:102', mountId: mount.id,
      },
      item: addToB.item, parent: { kind: 'sourceFolder', reservationId: sharedFolderB.id },
    },
  ],
} satisfies SavePlan;

export const secondArchivePlan = {
  ...archivePlan, id: 'plan:2', trigger: { kind: 'observation', observationId: 'observation:2' },
  effects: [
    {
      kind: 'ensureSourceFolder', effectId: 'effect:folder-consumer:2:B', commandId: 'command:folder-consumer:2:B',
      payloadDigest: 'fixture-consumer-2-digest', dependsOn: [], reservationId: sharedFolderB.id,
    },
    {
      kind: 'createBookmark', effectId: 'effect:bookmark:2:B', commandId: 'command:bookmark:2:B',
      payloadDigest: 'fixture-bookmark-2-digest', dependsOn: ['effect:folder-consumer:2:B'],
      representation: {
        connectionId: mount.connectionId, itemId: 'video:2', purpose: 'sourceArchive',
        sourceCollectionId: 'folder:102', mountId: mount.id,
      },
      item: { ...addToB.item, id: 'video:2', url: 'https://example.com/video/2', title: 'Video2' },
      parent: { kind: 'sourceFolder', reservationId: sharedFolderB.id },
    },
  ],
} satisfies SavePlan;

export const folderConsumers = [
  { reservationId: sharedFolderB.id, planId: archivePlan.id, effectId: 'effect:folder-consumer:1:B' },
  { reservationId: sharedFolderB.id, planId: secondArchivePlan.id, effectId: 'effect:folder-consumer:2:B' },
] satisfies readonly FolderReservationConsumer[];

// Independent import scenario: scanning is over; these frozen draft effects are
// not executable until the extension-page approval below is recorded.
export const frozenPreview = {
  id: 'preview:1', importRunId: 'import:1', revision: 1, digest: 'fixture-preview-digest',
  pageReceiptsDigest: 'fixture-pages-digest', ledgerOrdinal: 42, browserRules,
  policyRevision: keepBoth.revision, classificationPolicyDigest: 'fixture-policy-digest',
  mounts: [{ id: mount.id, revision: mount.revision }], coverage: 'complete', planIds: ['plan:import:1'],
  counts: { createFolders: 1, createBookmarks: 1, reuseBookmarks: 0, review: 0 },
} satisfies ImportPreview;

export const importApproval = {
  id: 'approval:1', importRunId: frozenPreview.importRunId, previewId: frozenPreview.id,
  previewRevision: frozenPreview.revision, previewDigest: frozenPreview.digest, approvedAt: 1700000040000,
} satisfies ImportApproval;

export const importDraftPlan = {
  ...archivePlan, id: 'plan:import:1',
  trigger: { kind: 'import', importRunId: frozenPreview.importRunId, previewId: frozenPreview.id },
  effects: archivePlan.effects.map((effect, index) => ({
    ...effect, effectId: `effect:import:${index}`, commandId: `command:import:${index}`,
    payloadDigest: `fixture-import-effect-${index}-digest`, dependsOn: index === 0 ? [] : ['effect:import:0'],
  })),
} satisfies SavePlan;

export const approvedImportPlan = {
  ...importDraftPlan, importApprovalId: importApproval.id,
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
  {
    sequence: ['resolvePopupItem', 'popupSemanticSave', 'addToB'],
    policy: semanticWins,
    expectedPaths: ['/root/servers/network-configuration/Video1'],
  },
  {
    sequence: ['popupSaveUnresolvedShortLink', 'addToB'],
    policy: semanticWins, expectedState: 'adoptionRequired',
  },
] as const;

// Behavioral specifications for future planner tests, not executable assertions.
export const boundaryExamples = [
  { scenario: 'twoItemsFirstAddedToB', plans: [archivePlan.id, secondArchivePlan.id], expectedFolderCreates: 1 },
  { scenario: 'sharedFolderOutcomeUnknown', expectedState: 'bothConsumersBlocked', expectedReplacementCreates: 0 },
  { scenario: 'cancelFirstConsumer', expectedState: 'secondConsumerMayContinue' },
  { scenario: 'BAndCWithOnlyBAdmitted', admittedCollections: ['folder:102'], expectedCollections: ['folder:102'] },
  { scenario: 'BAndCWithSeparateRules', expectedRoots: { 'folder:102': 'mount:B', 'folder:103': 'mount:C' } },
  { scenario: 'overlappingRulesForB', expectedWinner: 'firstEligibleMatch', laterMatches: 'shadowed' },
  { scenario: 'firstMatchHasMissingRoot', expectedState: 'blocked', expectedFallback: false },
  { scenario: 'singleCopyPrimaryBlocked', expectedState: 'review', expectedFallback: false },
  { scenario: 'readbackAfterOrdinal42', edge: 'folder:102', noInterveningObservation: true, expectedState: 'absent' },
  { scenario: 'readbackWithObservationAt43', edge: 'folder:102', expectedState: 'unresolved' },
  { scenario: 'inaccessibleReadback', edge: 'folder:103', expectedState: 'unresolved' },
  { scenario: 'scanAcknowledgedWithoutApproval', expectedImportWrites: 0 },
  { scenario: 'pageArrivesAfterPreviewFreeze', expectedPreviewExtension: false },
  { scenario: 'ruleListReorderedBeforeCommit', expectedState: 'previewRequired' },
] as const;
