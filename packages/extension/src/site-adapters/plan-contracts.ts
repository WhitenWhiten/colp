import type { ImportReviewSummary } from './import-problems.js';
import type { CapturePurpose, ContentIdentity, Id, SiteItem } from './contracts.js';
/**
 * Host-side records for local saves: browser rule snapshots, native bindings, folder reservations, import previews and plans.
 * Never page-authored; contracts.ts re-exports them.
 */

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

export interface SourceArchiveSavePolicy {
  revision: number;
  copies: 'sourceAndSemantic' | 'singlePreferSemantic' | 'singleKeepExisting';
  primarySourceCollectionId?: Id;
  /** Legacy wire name: disables classification of the sourceArchive effect only.
   * Independent semantic jobs require SourcePolicyRecord.semantic authorization. */
  backgroundClassification: 'disabled';
  /** A source archive is not a destructive mirror. */
  sourceRemoval: 'retainArchive';
}

/** Compatibility name for archived commands and adapter SDK consumers. */
export type SavePolicy = SourceArchiveSavePolicy;

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
  scopeId?: string;
  sourceConnections?: readonly string[];
}

export interface RepresentationKey {
  connectionId: Id;
  itemId: Id;
  purpose: CapturePurpose;
  /** Non-null for a collection-specific source copy; null for semantic. */
  sourceCollectionId: Id | null;
  /** Stable ID, never a mapping revision. Null for semantic placement. */
  mountId: Id | null;
  /** Semantic ownership belongs to a destination library/device, independently of website membership. */
  scopeId?: string;
}

/** Source content identity does not depend on an installation or a URL lookup. */
export interface Representation extends RepresentationKey {
  localTitle?: string;
  shared?: import('./managed-client.js').ManagedReference;
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
  locationOverride?: NativeBinding<'folder'>;
  shared?: import('./managed-client.js').ManagedReference;
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
  /** A shared folder may retain its original name after the website renames it. */
  nativeTitle?: string;
}

/** Persist with the plan; execution still checks that consumer's current approval. */
export interface FolderReservationConsumer {
  reservationId: Id;
  planId: Id;
  effectId: Id;
}

/** Frozen host preview; its digest covers scope, snapshots, counts and logical effects. */
export interface ImportPreview extends ImportReviewSummary {
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

/** Source archive execution uses this contract. Independent semantic work uses SemanticJob; ordinary captures keep their own contract. */
export interface SavePlan {
  /** Only on plans left by the removed hint-only packages; they fail closed. */
  communityOrigin?: import('./ledger-types.js').LegacyCommunityOrigin;
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
