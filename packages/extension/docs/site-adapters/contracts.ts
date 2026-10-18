/**
 * Proposed site adapter contracts. Documentation only; no production imports.
 * Runtime validation must enforce closed objects, bounds and graph semantics.
 */
export type Id = string;
export type CapturePurpose = 'sourceArchive' | 'semantic';
export type CaptureEntry = 'siteFavorite' | 'siteImport' | 'popup' | 'injectedControl' | 'reconcile';
export type Cleanup = () => void | Promise<void>;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface NamedReader {
  /** Exact host recipe and bounded scalar parameters; no URL/headers/body. */
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
  capabilities: readonly ('observeFavorites' | 'enumerateCollections' | 'enumerateItems' | 'mountCaptureControl')[];
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
  | { runtime: 'bundled' }
  | { runtime: 'userScript'; installationCredential: string }
);

export type BootstrapReply =
  | { status: 'ready'; leaseId: Id; capability: string; routeEpoch: number; expiresAt: number }
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
  | { operation: 'emit'; data: SiteObservation }
  | { operation: 'capture'; data: CaptureControlRequest }
  | { operation: 'read'; recipeId: string; params: Readonly<Record<string, string | number | boolean | null>> }
  | { operation: 'page.result'; readSessionId: Id; pageRequestId: Id; result: PageResult }
);

export type AdmissionReply =
  | { status: 'accepted' | 'duplicate'; receiptId: Id }
  | {
      status: 'rejected';
      reason: 'invalid' | 'conflict' | 'staleContext' | 'permissionRequired' | 'paused' | 'capacity' | 'rateLimited';
      retryAfterMs?: number;
    };

export type ReadFailure = {
  code: 'signedOut' | 'pageUnavailable' | 'navigationChanged' | 'rateLimited' | 'unsupported' | 'invalidData' | 'timeout' | 'cancelled';
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
      operation: 'readPage';
      leaseId: Id;
      readSessionId: Id;
      pageRequestId: Id;
      deadlineAt: number;
      query:
        | { kind: 'collections'; cursor: string | null }
        | { kind: 'items'; collectionId: Id; cursor: string | null };
    }
  | { operation: 'cancelRead'; readSessionId: Id }
  | { operation: 'invalidateLease'; leaseId: Id };

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
    | { kind: 'reconcile' };
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

export interface SiteAdapter {
  /** Called before bootstrap and after account/route invalidation. */
  detectSource(context: { document: Document; signal: AbortSignal }): Promise<SourceIdentityClaim>;
  start(context: AdapterContext): Promise<void | Cleanup>;
  readItem?(context: AdapterContext, itemId: Id): Promise<SiteItem | null>;
  readCollectionsPage?(context: ReadContext, cursor: string | null): Promise<SourcePage<SiteCollection>>;
  readItemsPage?(context: ReadContext, collectionId: Id, cursor: string | null): Promise<SourcePage<CollectionItem>>;
  importResume?: 'stableCursor' | 'restartAndDeduplicate';
}

/**
 * Local host extension attached to a BrowserRule record.
 * Its existing RuleDefinition is still validated/evaluated by @know-n/colp.
 * This is NOT an added field in the published RuleDefinition v1 schema.
 */
export interface BrowserSiteRuleExtension {
  version: 1;
  admission: {
    entries: readonly ('siteFavorite' | 'siteImport' | 'reconcile')[];
    purpose: 'sourceArchive';
    connectionId: Id;
    /** Match any listed collection; omitted means all for this connection. */
    collectionIds?: readonly Id[];
  };
  layout: { kind: 'sourceCollections'; rootRole: 'destination' };
}

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
}

export type TargetFolder =
  | { kind: 'native'; binding: NativeBinding<'folder'> }
  | { kind: 'planned'; folderEffectId: Id };

/** Planned parents resolve only after their folder effect has a proven receipt. */
export type SaveEffect = {
  effectId: Id;
  /** Stable across outbox retries; persisted before crossing databases. */
  commandId: Id;
  /** Logical effect digest; resolved native command has a separate outbox digest. */
  payloadDigest: string;
  dependsOn: readonly Id[];
} & (
  | { kind: 'ensureSourceFolder'; mountId: Id; collectionId: Id; parent: TargetFolder; title: string }
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
  | { kind: 'import'; importRunId: Id; pageReceiptId: Id }
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
  /** Semantic classification can proceed when no deterministic rule matched. */
  rule: { id: Id; revision: string } | null;
  /** Semantic plans need not have a source mount. */
  mount: { id: Id; revision: number } | null;
  policyRevision: number;
  classificationPolicyDigest: string;
  /** Explicitly disable tags as well as folder classification for sourceArchive. */
  classification: 'disabled' | 'authorizedSemantic';
  effects: readonly SaveEffect[];
}
