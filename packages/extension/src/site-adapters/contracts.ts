/**
 * Site adapter v1 contracts. Wire values must pass schemas.ts before use.
 * Runtime validation must enforce closed objects, bounds and graph semantics.
 */
export type Id = string;
export type CapturePurpose = 'sourceArchive' | 'semantic';
export type CaptureEntry = 'siteFavorite' | 'siteImport' | 'popup' | 'injectedControl' | 'reconcile';
export type Cleanup = () => void | Promise<void>;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface NamedReader {
  /** Host-recipe client after bootstrap; not the adapter-local page reader.
   * Exact recipe and bounded scalar parameters; no URL/headers/body. */
  read(recipeId: string, params: Readonly<Record<string, string | number | boolean | null>>): Promise<JsonValue>;
}

export interface AdapterManifest {
  apiVersion: 'known.site-adapter/v1';
  adapterId: Id;
  version: string;
  /** A namespace approved by the host when establishing a connection. */
  siteKey: string;
  /** Changes to item/collection normalization require a host-approved migration. */
  identityVersion: number;
  matches: readonly string[];
  execution: {
    mode: 'bundled' | 'userScript';
    /** A path within the installed, digest-pinned package. */
    entry: string;
    runAt: 'document_start' | 'document_idle';
  };
  capabilities: readonly ('observeFavorites' | 'resolveItem' | 'readMemberships' | 'enumerateCollections' | 'enumerateItems' | 'mountCaptureControl')[];
  /** Refers only to audited probes shipped with the extension. */
  bundledProbeIds?: readonly string[];
  /** Refers only to audited, named operations implemented by the host. */
  readRecipeIds?: readonly string[];
}

export interface SiteItem {
  id: Id;
  identity: 'siteId' | 'canonicalUrl';
  kind: 'video' | 'article' | 'post' | 'product' | 'repository' | 'other';
  url: string;
  title: string;
}

/** Host supplies namespace/version from its approved registry, not a page claim. */
export interface ContentIdentity {
  siteKey: string;
  identityVersion: number;
  itemId: Id;
}

export type ItemResolutionResult =
  | { status: 'resolved'; item: SiteItem }
  | { status: 'unresolved'; reason: 'unsupportedUrl' | 'ambiguousIdentity' | 'pageUnavailable' }
  | { status: 'failed'; error: ReadFailure };

export interface SiteCollection {
  id: Id;
  identity: 'siteId' | 'labelOnly';
  title: string;
  /** null means a known root; absence means unknown ancestry. */
  parentId?: Id | null;
}

export type MembershipChange =
  | { mode: 'delta'; added: readonly Id[]; removed: readonly Id[] }
  | {
      /** Complete membership of this item, not just the visible collections. */
      mode: 'complete';
      collectionIds: readonly Id[];
    };

export type Confirmation =
  | {
      kind: 'siteResponse';
      /** An adapter-known operation name; never raw request/response data. */
      operation: string;
    }
  | { kind: 'settledDom'; detector: string };

export type SiteObservation =
  | {
      type: 'catalog.upsert';
      /** At least one nonempty list is required by the semantic validator. */
      collections?: readonly SiteCollection[];
      items?: readonly SiteItem[];
    }
  | {
      type: 'favorite.confirmed';
      /** Stable for this interaction, captured before asynchronous completion. */
      interactionId: Id;
      item: SiteItem;
      memberships: MembershipChange;
      confirmation: Confirmation;
      /** Present only if the site exposes one; not automatically sortable. */
      sourceRevision?: string;
    }
  | {
      /** Existing state discovered by reading; not proof of a new user action. */
      type: 'membership.observed';
      item: SiteItem;
      memberships: MembershipChange;
      sourceRevision?: string;
    }
  | {
      type: 'favorite.uncertain';
      interactionId: Id;
      itemId: Id;
      reason: 'timeout' | 'ambiguousState' | 'accountChanged' | 'navigationChanged';
    };

export interface CaptureControlRequest {
  type: 'capture.requested';
  item: SiteItem;
  /** Presentation/request hint only. Does not authorize model dispatch. */
  requestedPurpose: CapturePurpose;
}

/** Page claims are checked against the host-bound connection; not authentication. */
export type SourceIdentityClaim =
  | { state: 'signedIn'; accountId: Id }
  | { state: 'signedOut' | 'unknown' };

/** Separate bootstrap channel; no writes, named reads, or model authority. */
export type BootstrapRequest = {
  protocolVersion: 1;
  operation: 'hello';
  adapterId: Id;
  source: SourceIdentityClaim;
} & (
  | { runtime: 'bundled'; activationId: Id }
  | { runtime: 'userScript'; installationCredential: string }
);

export type BootstrapReply =
  | { status: 'ready'; leaseId: Id; capability: string; routeEpoch: number; expiresAt: number; readerEpoch?: string }
  | { status: 'unavailable'; reason: 'version' | 'permissionRequired' | 'disabled' | 'sourceUnresolved' | 'reloadRequired' };

export interface AdapterEnvelope {
  protocolVersion: 1;
  /** Preserved until acceptance; reuse with different data is a conflict. */
  requestId: Id;
  /** Issued by the host; scoped to a document/source/installation generation. */
  leaseId: Id;
  /** Private transport credential; never put in DOM or a MAIN-world probe. */
  capability: string;
}

export type AdapterMessage = AdapterEnvelope & (
  | { operation: 'connect' }
  | { operation: 'membership.hint'; hint: MembershipHint }
  | { operation: 'emit'; data: SiteObservation }
  | { operation: 'capture'; data: CaptureControlRequest }
  | { operation: 'read'; recipeId: string; params: Readonly<Record<string, string | number | boolean | null>> }
  | { operation: 'page.result'; readSessionId: Id; pageRequestId: Id; result: PageResult }
  | { operation: 'item.result'; resolutionId: Id; result: ItemResolutionResult }
  | { operation: 'membership.result'; readSessionId: Id; readRequestId: Id; result: MembershipReadResult }
);

/** Forgeable page evidence: it may request a bounded read, never a native effect. */
export interface MembershipHint {
  interactionId: Id;
  itemId: Id;
  added: readonly Id[];
  removed: readonly Id[];
  code: number;
}

export type AdmissionReply =
  | { status: 'accepted' | 'duplicate'; receiptId: Id }
  | {
      status: 'rejected';
      reason: 'invalid' | 'conflict' | 'staleContext' | 'permissionRequired' | 'paused' | 'capacity' | 'rateLimited';
      retryAfterMs?: number;
    };

export type ReadFailure = {
  code: 'signedOut' | 'pageUnavailable' | 'navigationChanged' | 'rateLimited' | 'unsupported' | 'invalidData' | 'timeout' | 'cancelled' | 'challenge' | 'network' | 'capacity' | 'staleCursor';
  retryAfterMs?: number;
};

export type AdapterReply = AdmissionReply
  | { status: 'readResult'; value: JsonValue }
  | { status: 'readFailed'; error: ReadFailure };

/** Port replies require explicit correlation; sendMessage provides its own. */
export interface HostReply {
  operation: 'reply';
  requestId: Id;
  reply: AdapterReply;
}

/** Sent only on a bootstrapped port; not a callable page-authored host API. */
export type HostCommand =
  | {
      operation: 'resolveItem';
      leaseId: Id;
      resolutionId: Id;
      /** Host-observed URL in this document, not an arbitrary fetch target. */
      url: string;
      deadlineAt: number;
    }
  | {
      operation: 'readPage';
      leaseId: Id;
      readSessionId: Id;
      pageRequestId: Id;
      deadlineAt: number;
      query:
        | { kind: 'collections'; cursor: string | null }
        | { kind: 'items'; collectionId: Id; cursor: string | null };
    }
  | {
      operation: 'readMemberships';
      leaseId: Id;
      readSessionId: Id;
      readRequestId: Id;
      deadlineAt: number;
      query: MembershipReadQuery;
    }
  | { operation: 'cancelRead'; readSessionId: Id }
  | { operation: 'renewLease'; leaseId: Id }
  | { operation: 'invalidateLease'; leaseId: Id }
  | { operation: 'shutdown'; leaseId: Id };

export type HostMessage = HostCommand | HostReply;

/** Internal host record. Never accepted as an adapter-authored envelope. */
export interface AcceptedObservation {
  observationId: Id;
  requestId: Id;
  installationId: Id;
  installationGeneration: number;
  adapterVersion: string;
  connectionId: Id;
  collectorGeneration: number;
  sourceSessionGeneration: number;
  sender: { tabId: number; frameId: 0; documentId: string; origin: string; routeEpoch: number };
  acceptedAt: number;
  ordinal: number;
  cause:
    | { kind: 'siteFavorite'; interactionId: Id }
    | { kind: 'siteImport'; importRunId: Id }
    | { kind: 'reconcile'; readRequestId?: Id };
  observation: SiteObservation;
}

/**
 * Page-local API. DOM objects and callbacks never cross the wire.
 * This interface restricts host powers, not all behavior of arbitrary JS.
 */
export interface AdapterContext {
  document: Document;
  signal: AbortSignal;
  /** Immutable for this context; route changes abort it and create another. */
  readonly routeEpoch: number;
  emit(observation: SiteObservation): Promise<AdmissionReply>;
  requestCapture(request: CaptureControlRequest): Promise<AdmissionReply>;
  /** Present only when the host has granted audited read recipes. */
  reader?: NamedReader;
  onRouteChange(callback: () => void): Cleanup;
  dom: {
    on(root: Document | Element, event: string, selector: string, callback: (element: Element, event: Event) => void): Cleanup;
    observe(root: Element, options: MutationObserverInit, callback: (records: readonly MutationRecord[]) => void): Cleanup;
    waitFor<T>(read: () => T | null, options: { timeoutMs: number; signal: AbortSignal }): Promise<T>;
  };
  ui: {
    mountControl(input: {
      id: string;
      anchor: Element;
      position: 'beforebegin' | 'afterend' | 'beforeend';
      /** Host-localized text/icon, not arbitrary HTML or a consent claim. */
      action: 'save' | 'saveAndClassify';
      resolveItem(): Promise<SiteItem | null>;
      purpose: CapturePurpose;
    }): Cleanup;
  };
}

export interface ReadContext {
  document: Document;
  signal: AbortSignal;
  /** Opaque, host-issued task binding; not an adapter-selected account. */
  readSessionId: Id;
  reader?: NamedReader;
}

export type SourcePage<T> = {
  items: readonly T[];
  /** null ends this traversal, not necessarily an authoritative snapshot. */
  nextCursor: string | null;
  /** Coverage of this requested page only; host computes run-level coverage. */
  coverage: 'partial' | 'complete';
  omissions?: readonly { id: Id; reason: 'invalid' | 'unsupported' | 'missing' | 'failed' }[];
} & (
  | { consistency: 'bestEffort' }
  /** Host verifies source-defined snapshot semantics, not just token presence. */
  | { consistency: 'pointInTime'; snapshotId: string }
);

export interface CollectionItem {
  item: SiteItem;
  /** Host also knows the collection requested for this page. */
  membershipRevision?: string;
}

export type PageResult =
  | { status: 'ok'; kind: 'collections'; page: SourcePage<SiteCollection> }
  | { status: 'ok'; kind: 'items'; collectionId: Id; page: SourcePage<CollectionItem> }
  | { status: 'failed'; error: ReadFailure };

export interface MembershipReadQuery {
  itemId: Id;
  /** Nonempty, unique, at most 64. Read only these edges. */
  collectionIds: readonly Id[];
}

export type MembershipReadEdge = { collectionId: Id } & (
  | {
      state: 'present' | 'absent';
      /** Fresh scoped evidence acquired after this host request. */
      evidence: { kind: 'siteResponse'; operation: string } | { kind: 'refreshedDom'; detector: string };
    }
  | { state: 'unknown'; reason: 'notVisible' | 'inaccessible' | 'unsupported' | 'ambiguousState' }
);

export type MembershipReadResult =
  | {
      status: 'ok';
      itemId: Id;
      /** Exactly one result per requested edge; no omitted/extra/duplicate IDs. */
      edges: readonly MembershipReadEdge[];
      /** Comparable only through a host-supported site revision contract. */
      sourceRevision?: string;
    }
  | { status: 'failed'; error: ReadFailure };

/** Durable host record created before dispatch; never accepted from a page. */
export interface MembershipReadRequest {
  id: Id;
  readSessionId: Id;
  connectionId: Id;
  collectorGeneration: number;
  sourceSessionGeneration: number;
  leaseId: Id;
  baselineOrdinal: number;
  deadlineAt: number;
  query: MembershipReadQuery;
}

export interface SiteAdapter {
  /** Called before bootstrap and after account/route invalidation.
   * Any page-side account read must be fixed/bounded; no lease-bound host reader yet. */
  detectSource(context: { document: Document; signal: AbortSignal }): Promise<SourceIdentityClaim>;
  start(context: AdapterContext): Promise<void | Cleanup>;
  resolveItem?(context: AdapterContext, url: string): Promise<ItemResolutionResult>;
  readItem?(context: AdapterContext, itemId: Id): Promise<SiteItem | null>;
  readMemberships?(context: ReadContext, query: MembershipReadQuery): Promise<MembershipReadResult>;
  readCollectionsPage?(context: ReadContext, cursor: string | null): Promise<SourcePage<SiteCollection>>;
  readItemsPage?(context: ReadContext, collectionId: Id, cursor: string | null): Promise<SourcePage<CollectionItem>>;
  importResume?: 'stableCursor' | 'restartAndDeduplicate';
}

/**
 * Local host extension attached to LocalRule in the proposed v3 ordered list.
 * Existing predicates are compiled by @know-n/colp; list order decides the winner.
 * This is NOT an added field in the published RuleDefinition v1 schema.
 */
export interface BrowserSiteRuleExtension {
  version: 1;
  admission: {
    entries: readonly ('siteFavorite' | 'siteImport' | 'reconcile')[];
    purpose: 'sourceArchive';
    connectionId: Id;
    /** Match the current edge's collection only; omitted means all for this connection. */
    collectionIds?: readonly Id[];
  };
  /** Requires a file action; resolves direct folder or local set role binding. */
  layout: { kind: 'sourceCollections'; root: 'actionDestination' };
}

/** Pin even a no-match evaluation; list order and subscribed predicates can change. */
export interface BrowserRuleSnapshot {
  storageVersion: 3;
  listRevision: number;
  contentVersions: Readonly<Record<string, string>>;
}

export type BrowserRuleRef =
  | { kind: 'rule'; ruleId: Id }
  | { kind: 'setRule'; setId: Id; ruleId: Id }
  | { kind: 'subscriptionEntry'; subscriptionId: Id; entryId: Id; contentVersion: string };

export type PlacementRule =
  | { source: 'browser'; entry: BrowserRuleRef; definitionDigest: string }
  | { source: 'account'; id: Id; revision: string; bundleRevision: string; bindingRevision: string };

export interface MountBinding {
  id: Id;
  connectionId: Id;
  rootRuleId: Id;
  root: NativeBinding<'folder'>;
  revision: number;
  aiDestination: 'excluded' | 'allowed';
}

export interface SavePolicy {
  revision: number;
  copies: 'sourceAndSemantic' | 'singlePreferSemantic' | 'singleKeepExisting';
  primarySourceCollectionId?: Id;
  /** No model call on site events/import/reconcile in phase one. */
  backgroundClassification: 'disabled';
  /** A source archive is not a destructive mirror. */
  sourceRemoval: 'retainArchive';
}

/** Device-local identity; backups cannot execute or adopt these IDs on restore. */
export interface NativeBinding<Kind extends 'bookmark' | 'folder' = 'bookmark' | 'folder'> {
  bindingId: Id;
  deviceId: Id;
  nativeId: Id;
  kind: Kind;
  /** Missing proof blocks automatic mutation; null is not a wildcard match. */
  dateAdded: number | null;
  proof: { kind: 'writeReceipt' | 'explicitAdoption'; id: Id };
}

/** Exists before any favorite; attach native proof only after the semantic save. */
export interface CaptureContentBinding {
  id: Id;
  content: ContentIdentity;
  captureIntentId: Id;
  purpose: 'semantic';
  native: NativeBinding<'bookmark'> | null;
  /** null until adopted into a verified connection under the configured policy. */
  connectionId: Id | null;
}

export interface RepresentationKey {
  connectionId: Id;
  itemId: Id;
  purpose: CapturePurpose;
  /** Non-null for a collection-specific source copy; null for semantic. */
  sourceCollectionId: Id | null;
  /** Stable ID, never a mapping revision. Null for semantic placement. */
  mountId: Id | null;
}

/** Source content identity does not depend on an installation or a URL lookup. */
export interface Representation extends RepresentationKey {
  /** Retain the proven historical identity even when a node was deleted. */
  native: NativeBinding<'bookmark'>;
  manualRevision: number;
  state: 'active' | 'detached' | 'suppressed';
  lastWritten?: { title: string; parentId: string; url?: string };
}

export type TargetFolder =
  | { kind: 'native'; binding: NativeBinding<'folder'> }
  | { kind: 'sourceFolder'; reservationId: Id };

/** Unique (mountId, collectionId); shared across items, tabs, imports and plans. */
export interface SourceFolderReservation {
  id: Id;
  mountId: Id;
  collectionId: Id;
  mountRevision: number;
  parent: TargetFolder;
  title: string;
  /** Only this command may create the folder. Consumer effects never create it. */
  commandId: Id;
  payloadDigest: string;
  state: 'reserved' | 'submitted' | 'unknown' | 'confirmed' | 'blocked';
  /** Required when confirmed; unknown blocks every consumer, including new ones. */
  native: NativeBinding<'folder'> | null;
}

/** Persist with the plan; execution still checks that consumer's current approval. */
export interface FolderReservationConsumer {
  reservationId: Id;
  planId: Id;
  effectId: Id;
}

/** Frozen host preview; its digest covers scope, snapshots, counts and logical effects. */
export interface ImportPreview {
  id: Id;
  importRunId: Id;
  revision: number;
  digest: string;
  pageReceiptsDigest: string;
  collectedSetDigest?: string;
  plansDigest?: string;
  omissions?: { count: number; samples: readonly { id: string; reason: string; collectionId?: string }[]; unscannedRemainder: boolean };
  ledgerOrdinal: number;
  browserRules: BrowserRuleSnapshot;
  policyRevision: number;
  classificationPolicyDigest: string;
  mounts: readonly { id: Id; revision: number }[];
  coverage: 'complete' | 'partial';
  /** References frozen draft plans; they gain write authorization only at commit. */
  planIds: readonly Id[];
  counts: { createFolders: number; createBookmarks: number; reuseBookmarks: number; review: number };
}

/** Created only by an extension-page commit, never by page acknowledgments. */
export interface ImportApproval {
  state?: 'active' | 'cancelled';
  id: Id;
  importRunId: Id;
  previewId: Id;
  previewRevision: number;
  previewDigest: string;
  approvedAt: number;
}

/** Source-folder parents resolve only from their shared reservation's receipt. */
export type SaveEffect = {
  effectId: Id;
  /** Stable consumer command; ensureSourceFolder's native command belongs to its reservation. */
  commandId: Id;
  /** Logical effect digest; resolved native command has a separate outbox digest. */
  payloadDigest: string;
  /** Immutable digest of a referenced shared folder creation payload. */
  folderReservationDigest?: string;
  dependsOn: readonly Id[];
} & (
  | { kind: 'ensureSourceFolder'; reservationId: Id }
  | { kind: 'createBookmark'; representation: RepresentationKey; item: SiteItem; parent: TargetFolder }
  | { kind: 'reuseBookmark'; native: NativeBinding<'bookmark'>; representation: RepresentationKey; expectedManualRevision: number }
  | {
      kind: 'moveManagedBookmark'; native: NativeBinding<'bookmark'>; representation: RepresentationKey;
      expectedParent: NativeBinding<'folder'>; expectedManualRevision: number; target: TargetFolder;
    }
  | { kind: 'review'; reason: string }
);

export type PlanTrigger =
  | { kind: 'observation'; observationId: Id }
  | { kind: 'import'; importRunId: Id; previewId: Id }
  | { kind: 'semanticSave'; captureIntentId: Id };

/** A plan for a source-linked intent; ordinary captures keep their own contract. */
export interface SavePlan {
  id: Id;
  trigger: PlanTrigger;
  purpose: CapturePurpose;
  connectionId: Id;
  installationGeneration: number;
  collectorGeneration: number;
  sourceSessionGeneration: number;
  /** Required for import dispatch; draft import plans have null until exact preview approval. */
  importApprovalId: Id | null;
  /** Null only if browser rules were not evaluated, e.g. an account rule won. */
  browserRules: BrowserRuleSnapshot | null;
  /** Semantic classification can proceed when no deterministic rule matched. */
  rule: PlacementRule | null;
  /** Semantic plans need not have a source mount. */
  mount: { id: Id; revision: number } | null;
  policyRevision: number;
  classificationPolicyDigest: string;
  /** Explicitly disable tags as well as folder classification for sourceArchive. */
  classification: 'disabled' | 'authorizedSemantic';
  effects: readonly SaveEffect[];
}
