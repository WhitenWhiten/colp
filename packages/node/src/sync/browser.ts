/**
 * Browser-safe Sync helpers: `@know-n/colp/sync/browser`.
 *
 * Every module reachable from this entry is free of Node built-ins and of any
 * implicit `Buffer` requirement, so MV3 service workers, pages and other
 * browser bundles can import it without polyfills. Function objects are the
 * same ones `./sync` exports.
 *
 * Deliberately absent (server/runtime-dependent):
 * - Session, Sequence, Push, Pull and Replica lifecycle coordinators, and
 *   Pull/effect-page validators (JSON Schema registry, `Buffer` byte budgets);
 * - `mergeSyncTypedUpdate` and other helpers built on the immutable JSON
 *   snapshot, whose Proxy rejection uses `node:util/types`. That input
 *   protection is kept intact for servers rather than weakened for browsers.
 *
 * `./sync/canonical` remains supported; this entry re-exports all of it.
 */

export * from './canonical.js';

export {
  applySyncBrowserBatch,
  type SyncBrowserBatchAdapter,
  type SyncBrowserBatchChange,
  type SyncBrowserBatchDriver,
} from './browser-batch-adapter.js';

export {
  translateSyncBrowserDelete,
  translateSyncBrowserDeleteOperation,
  translateSyncBrowserEvent,
  type SyncBrowserDeleteTranslation,
  type SyncBrowserEvent,
  type SyncBrowserEventOperationContext,
  type SyncBrowserEventType,
  type SyncBrowserNodeKind,
} from './browser-event-translation.js';

export { type SubtreeMemberRevision } from './subtree-observation.js';

export {
  adviseLightPullBeforePush,
  type LightPullAdvisory,
  type LightPullAdvisoryFacts,
} from './light-pull-advisory.js';

export {
  NETSCAPE_BOOKMARK_FILE_MARKER,
  parseNetscapeBookmarkHtml,
  type NetscapeBookmarkDocument,
  type NetscapeBookmarkEntry,
  type NetscapeBookmarkFolder,
  type NetscapeBookmarkItem,
} from './netscape-bookmark.js';

export {
  SAFARI_ADAPTER_PROFILE,
  assertPublicHttpManifest,
  assertSafariReplicaCapability,
  declareSafariReplicaCapability,
  type SafariReplicaCapability,
} from './replica-capability.js';

export {
  establishSyncRootMapping,
  resolveSyncRootMapping,
  type SyncBrowserRoot,
  type SyncRootMapping,
  type SyncRootMappingAdapter,
} from './root-mapping.js';

export {
  projectSyncSeparatorForUi,
  representSyncSeparatorForUiMode,
  type SyncSeparatorVisualMode,
  type SyncSeparatorVisualPresentation,
} from './separator-visual.js';

export {
  exportSyncSidecars,
  persistSyncSidecar,
  type SyncSidecarAdapter,
  type SyncSidecarExportAdapter,
  type SyncSidecarExporter,
  type SyncSidecarRecord,
} from './sidecar.js';

export {
  defaultServerTransportBudget,
  encodeSyncTransportBudgetHeader,
  jsonFitsTransportBudget,
  LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  legacySyncTransportBudget,
  negotiateSyncTransportBudget,
  parseSyncTransportBudget,
  parseSyncTransportBudgetHeader,
  readDeclaredTransportBudget,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
  SYNC_TRANSPORT_BUDGET_KEYS,
  SYNC_TRANSPORT_BUDGET_MAX_BYTES,
  SYNC_TRANSPORT_BUDGET_MIN_BYTES,
  utf8JsonByteLength,
  type SyncTransportBudget,
} from './transport-budget.js';

export {
  SyncTypedUpdateSemanticError,
  assertSyncTypedUpdateOperationPayload,
  validateSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
  type SyncTypedUpdateSemanticValidationResult,
} from './typed-operations.js';
