import type {
  ProductSyncConflictResolution,
  SyncConflictSummary,
  SyncReplicaView,
  SyncTrashListItem,
} from '../../api'
import type { StatusTone } from '../../components/StatusBadge'
import { productName } from '../../lib/edition'

export type Resolution = ProductSyncConflictResolution['resolution']
export type IntentPhase = 'idle' | 'submitting' | 'unknown' | 'stale' | 'refresh_required' | 'blocked' | 'invalid'
export type FrozenIntent = {
  intentId: string
  revision: string
  request: ProductSyncConflictResolution
}
export type ConflictDraft = {
  resolution: Resolution
  customText: string
  phase: IntentPhase
  message: string | null
  frozen: FrozenIntent | null
}
export type RetirePhase = 'idle' | 'confirming' | 'submitting' | 'unknown' | 'stale' | 'blocked'
export type FrozenRetire = { intentId: string; etag: string }
export type RetireDraft = { phase: RetirePhase; message: string | null; frozen: FrozenRetire | null }
export type RestorePhase = 'idle' | 'submitting' | 'unknown' | 'stale' | 'blocked'
export type FrozenRestore = { intentId: string; ifMatch: string }
export type RestoreDraft = { phase: RestorePhase; message: string | null; frozen: FrozenRestore | null }

export const RESOLUTIONS: ReadonlyArray<{ value: Resolution; label: string; detail: string }> = [
  { value: 'server', label: `Keep the ${productName()} version`, detail: `Keep the value saved in ${productName()}.` },
  { value: 'incoming', label: 'Keep the browser version', detail: 'Use the change made in the browser.' },
  { value: 'custom', label: 'Custom value', detail: 'Type the value to keep.' },
  { value: 'both', label: 'Keep both', detail: 'Keep both as separate items.' },
]

export const STATUS_LABELS: Record<SyncReplicaView['status'], string> = {
  active: 'Active', expired: 'Inactive', recovery_required: 'Recovery required', retired: 'Stopped syncing',
}

export const REPLICA_KIND_LABELS: Record<SyncReplicaView['kind'], string> = {
  browser_extension: 'Browser extension', desktop_client: 'Desktop app', mobile_client: 'Mobile app',
  server: 'Server', importer: 'Importer', other: 'Other',
}

export const CONFLICT_TYPE_LABELS: Record<SyncConflictSummary['type'], string> = {
  concurrent_field_update: 'Changed in both places',
  unprovable_base: "Can't tell which version is newer",
  untrusted_base: "Can't tell which version is newer",
  delete_update: 'Deleted in one place, changed in the other',
}

export const REPLICA_STATE_TONE: Record<SyncReplicaView['status'], StatusTone> = {
  active: 'success',
  expired: 'warning',
  recovery_required: 'warning',
  retired: 'muted',
}

export const TRASH_KIND_LABELS: Record<SyncTrashListItem['kind'], string> = {
  folder: 'Folder', bookmark: 'Bookmark', separator: 'Separator',
}

export const INTENT_MESSAGE_CLASS: Record<string, string> = {
  unknown: 'is-unknown',
  stale: 'is-stale',
  refresh_required: 'is-refresh_required',
  invalid: 'is-invalid',
  blocked: 'is-blocked',
}

export const EMPTY_RETIRE: RetireDraft = { phase: 'idle', message: null, frozen: null }
export const EMPTY_RESTORE: RestoreDraft = { phase: 'idle', message: null, frozen: null }

export type BatchRestorePhase = 'idle' | 'submitting' | 'unknown' | 'blocked'
export type FrozenBatchRestore = { intentId: string; deletionIds: readonly string[] }
export type BatchRestoreDraft = { phase: BatchRestorePhase; message: string | null; frozen: FrozenBatchRestore | null }
export type EmptyTrashPhase = 'idle' | 'confirming' | 'submitting' | 'unknown' | 'blocked' | 'stale'
export type FrozenEmptyTrash = { intentId: string; expectedCount: number }
export type EmptyTrashDraft = { phase: EmptyTrashPhase; message: string | null; frozen: FrozenEmptyTrash | null }

export const EMPTY_BATCH_RESTORE: BatchRestoreDraft = { phase: 'idle', message: null, frozen: null }
export const EMPTY_EMPTY_TRASH: EmptyTrashDraft = { phase: 'idle', message: null, frozen: null }

export const RESTORE_OUTCOME_LABELS: Record<string, string> = {
  applied: 'Restored',
  precondition_failed: 'Changed since you loaded this page',
  purged: 'No longer restorable',
  not_found: 'Not found',
}

export const EMPTY_SKIP_LABELS: Record<string, string> = {
  retention_window: 'Kept for the 30-day retention window',
  replica_checkpoint: 'Kept until every browser has synced the deletion',
  watermark: 'Kept until earlier deletions finish syncing',
}
