import type { ClassificationRunCreateRequest, ClassificationRunApplyRequest } from '../../api'
export type BatchIntent = { intentId: string } & (
  | { kind: 'create'; document: ClassificationRunCreateRequest }
  | { kind: 'cancel'; runId: string; etag: string }
  | { kind: 'apply'; runId: string; etag: string; document: ClassificationRunApplyRequest }
)
export interface BatchSession { runId?: string; pending?: BatchIntent; savedAt: number }
export function batchSessionKey(accountId: string, collectionId: string, runId?: string) {
  return `known.classification-batch.v1:${JSON.stringify([accountId, collectionId, runId ?? 'new'])}`
}
export function readBatchSession(key: string): BatchSession | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw || raw.length > 256 * 1024) return null
    const value = JSON.parse(raw) as BatchSession
    if (!value || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > 86400000) return null
    if (value.runId !== undefined && (typeof value.runId !== 'string' || !value.runId || value.runId.length > 128)) return null
    const pending = value.pending
    if (pending && (typeof pending.intentId !== 'string' || !pending.intentId || pending.intentId.length > 1024)) return null
    if (pending?.kind === 'create') {
      const body = pending.document as Record<string, unknown>
      if (!body || !body.requested || typeof body.maxItems !== 'number' || !Number.isInteger(body.maxItems) || body.maxItems < 1 || body.maxItems > 50
        || !Array.isArray(body.sourceFolderIds) || body.sourceFolderIds.length !== 1 || typeof body.sourceFolderIds[0] !== 'string') return null
    } else if (pending && (pending.kind !== 'apply' && pending.kind !== 'cancel' || typeof pending.runId !== 'string'
      || typeof pending.etag !== 'string' || !pending.etag.startsWith('"'))) return null
    if (pending?.kind === 'apply' && (!Array.isArray(pending.document?.selections) || !pending.document.selections.length || pending.document.selections.length > 50)) return null
    return value
  } catch { return null }
}
export function writeBatchSession(key: string, value: Omit<BatchSession, 'savedAt'>) {
  try { sessionStorage.setItem(key, JSON.stringify({ ...value, savedAt: Date.now() })) } catch { /* The active page still retains its immutable intent. */ }
}
export function clearBatchSession(key: string) {
  try { sessionStorage.removeItem(key) } catch { /* No private payload is required to open a new batch. */ }
}
