import type { SyncConflictSummary, SyncStatusView } from '../../api'
import { formatMediumInstant } from '../../lib/formatDate'
import type { ConflictDraft, Resolution } from './types'

export function formatInstant(value: string | null): string {
  return formatMediumInstant(value)
}

export function ownedSyncCollectionIds(status: SyncStatusView | null): string[] {
  if (!status) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const replica of status.replicas) {
    if (seen.has(replica.collectionId)) continue
    seen.add(replica.collectionId)
    ids.push(replica.collectionId)
  }
  return ids
}

export function quotedEntityTag(revision: string): string {
  return /^".+"$/u.test(revision) ? revision : `"${revision}"`
}

export function fieldName(field: string | null): string {
  if (!field) return 'Multiple fields'
  const value = field.replace(/^\//u, '')
  return value ? value.replaceAll('~1', '/').replaceAll('~0', '~') : 'Item'
}

export function customField(field: string | null): 'title' | 'url' | 'canonicalUrl' | 'description' | 'tags' | 'visibility' | null {
  const value = field?.replace(/^\//u, '')
  return value === 'title' || value === 'url' || value === 'canonicalUrl'
    || value === 'description' || value === 'tags' || value === 'visibility' ? value : null
}

/** A refreshed conflict may remove a choice or turn one field into several. */
export function canResolveConflict(conflict: SyncConflictSummary, resolution: Resolution): boolean {
  return conflict.allowedResolutions.includes(resolution)
    && (resolution !== 'custom' || customField(conflict.field) !== null)
}

export function parseCustomValue(conflict: SyncConflictSummary, text: string): { value?: unknown; error?: string } {
  const field = customField(conflict.field)
  if (!field) return { error: 'Custom editing is unavailable for this conflict field.' }
  if (field === 'title') {
    // Conflict summaries do not identify the node kind. An exact empty title
    // may be valid for a bookmark; the server still checks the actual kind.
    if (text.length > 512 || (text !== '' && text.trim().length === 0)) return { error: 'Title must be at most 512 characters and cannot contain only whitespace.' }
    return { value: text }
  }
  if (field === 'description') {
    if (text.length > 20_000) return { error: 'Description must be at most 20,000 characters.' }
    return { value: text }
  }
  if (field === 'tags') {
    const tags = text === '' ? [] : text.split('\n')
    if (tags.length > 64 || tags.some((tag) => tag.length < 1 || tag.length > 64 || tag.trim().length === 0)
      || new Set(tags).size !== tags.length) return { error: 'Use at most 64 unique tags, one per line, each 1 to 64 characters.' }
    return { value: tags }
  }
  if (field === 'visibility') {
    if (!['inherit', 'protected', 'private'].includes(text)) return { error: 'Choose a supported visibility.' }
    return { value: text }
  }
  if (field === 'canonicalUrl' && text === '') return { value: null }
  if (text.length < 8 || text.length > 4096 || /\s/u.test(text)) return { error: 'URL must be an absolute HTTP or HTTPS URL without credentials.' }
  try {
    const parsed = new URL(text)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw new Error('invalid')
  } catch {
    return { error: 'URL must be an absolute HTTP or HTTPS URL without credentials.' }
  }
  return { value: text }
}

export function initialDraft(conflict: SyncConflictSummary): ConflictDraft {
  const resolution = conflict.allowedResolutions[0] ?? 'server'
  return { resolution, customText: conflict.summary.incoming ?? '', phase: 'idle', message: null, frozen: null }
}
