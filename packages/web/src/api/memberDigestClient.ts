import { apiUrl } from './config'
import { getSessionSnapshot, privateSessionIdentity } from './sessionStore'
import { subscriptionSessionFetch, SubscriptionSessionChanged } from './subscriptionSessionFetch'
export type MemberDigestSource = { sourceType: 'digest_series'; sourceId: string; title: string; owner: { displayName: string; handle: string | null } | null; openUrl: string; visibility: string }
export type MemberDigestEdition = { editionId: string; title: string; publishedAt: string }
export type MemberDigestNode = { key: string; parentKey: string | null; index: number; kind: 'folder' | 'bookmark'; role: string; title: string; url?: string }
export type MemberDigestSeries = { series: MemberDigestSource; editions: MemberDigestEdition[]; nextCursor: string | null }
export type MemberDigestAnnotation = { id: string; subjectType: 'collection' | 'node'; subjectId: string; type: string; format: string | null; value: unknown }
export type MemberDigestDetails = { seriesSummary: string | null; editionSummary: string | null; sourceSummary: string | null; notes: { key: string; description: string | null }[]; annotations: MemberDigestAnnotation[] }
export type MemberDigestIssue = { series: MemberDigestSource; edition: MemberDigestEdition; nodes: MemberDigestNode[]; reader?: MemberDigestDetails }
export function memberNodeReference(key: string, reportId: string, editionId: string): { collectionId: string; nodeId: string } | null {
  try { const value: unknown = JSON.parse(key); return Array.isArray(value) && value.length === 5 && value[0] === 'digest' && value[1] === reportId && value[2] === editionId && typeof value[3] === 'string' && typeof value[4] === 'string' ? { collectionId: value[3], nodeId: value[4] } : null } catch { return null }
}
export class MemberDigestError extends Error { constructor(public readonly status: number, message = 'Digest unavailable') { super(message) } }
const validId = (id: string) => /^[A-Za-z0-9._~-]{1,128}$/.test(id)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function source(value: unknown): value is MemberDigestSource { return object(value) && value.sourceType === 'digest_series' && typeof value.sourceId === 'string' && validId(value.sourceId) && typeof value.title === 'string' }
function edition(value: unknown): value is MemberDigestEdition { return object(value) && typeof value.editionId === 'string' && validId(value.editionId) && typeof value.title === 'string' && typeof value.publishedAt === 'string' && Number.isFinite(Date.parse(value.publishedAt)) }
async function read(path: string, signal?: AbortSignal): Promise<unknown> {
  if (!getSessionSnapshot().authenticated) throw new MemberDigestError(401)
  const identity = privateSessionIdentity()
  const response = await subscriptionSessionFetch(apiUrl(path), { signal, headers: { Accept: 'application/json' } }).catch(error => { if (error instanceof SubscriptionSessionChanged) throw new MemberDigestError(401, error.message); throw error })
  if (privateSessionIdentity() !== identity) throw new MemberDigestError(401, 'Session changed')
  if (!response.ok) throw new MemberDigestError(response.status)
  if (!response.headers.get('content-type')?.includes('application/json')) throw new MemberDigestError(502, 'Invalid reader response')
  const max = 32 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > max) throw new MemberDigestError(413)
  const reader = response.body?.getReader(); if (!reader) throw new MemberDigestError(502)
  const chunks: Uint8Array[] = []; let bytes = 0
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > max) { await reader.cancel(); throw new MemberDigestError(413) } chunks.push(chunk.value) } } finally { reader.releaseLock() }
  if (privateSessionIdentity() !== identity) throw new MemberDigestError(401, 'Session changed')
  const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(joined)) as unknown
}
export async function getMemberDigest(reportId: string, options: { cursor?: string; signal?: AbortSignal } = {}): Promise<MemberDigestSeries> {
  if (!validId(reportId)) throw new MemberDigestError(404)
  const result = await read('/api/v1/me/report-readers/' + encodeURIComponent(reportId) + (options.cursor ? '?cursor=' + encodeURIComponent(options.cursor) : ''), options.signal)
  if (!object(result) || !source(result.series) || result.series.sourceId !== reportId || !Array.isArray(result.editions) || result.editions.length > 50 || !result.editions.every(edition) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new MemberDigestError(502, 'Invalid reader response')
  return result as MemberDigestSeries
}
export async function getMemberDigestIssue(reportId: string, editionId: string, signal?: AbortSignal): Promise<MemberDigestIssue> {
  if (!validId(reportId) || !validId(editionId)) throw new MemberDigestError(404)
  const result = await read('/api/v1/me/report-readers/' + encodeURIComponent(reportId) + '/editions/' + encodeURIComponent(editionId), signal)
  if (!object(result) || !source(result.series) || result.series.sourceId !== reportId || !edition(result.edition) || result.edition.editionId !== editionId || !Array.isArray(result.nodes) || result.nodes.length > 20000) throw new MemberDigestError(502, 'Invalid reader response')
  const keys = new Set<string>(); const depth = new Map<string,number>()
  for (const node of result.nodes) {
    if (!object(node) || typeof node.key !== 'string' || keys.has(node.key) || typeof node.title !== 'string' || !['folder','bookmark'].includes(String(node.kind)) || !(node.parentKey === null || typeof node.parentKey === 'string' && keys.has(node.parentKey))) throw new MemberDigestError(502, 'Invalid reader tree')
    const level = node.parentKey === null ? 0 : (depth.get(String(node.parentKey)) ?? 0) + 1; if (level > 128) throw new MemberDigestError(413)
    if (node.kind === 'bookmark' && !safeMemberHref(node.url)) throw new MemberDigestError(502, 'Invalid reader URL')
    keys.add(node.key); depth.set(node.key,level)
  }
  if (result.reader !== undefined) {
    const reader = result.reader, nullableText = (value: unknown) => value === null || typeof value === 'string'
    if (!object(reader) || ![reader.seriesSummary, reader.editionSummary, reader.sourceSummary].every(nullableText) || !Array.isArray(reader.notes) || reader.notes.length > 20000 || !Array.isArray(reader.annotations) || reader.annotations.length > 20000) throw new MemberDigestError(502, 'Invalid reader metadata')
    const noteKeys = new Set<string>()
    for (const note of reader.notes) { if (!object(note) || typeof note.key !== 'string' || !keys.has(note.key) || noteKeys.has(note.key) || !nullableText(note.description)) throw new MemberDigestError(502, 'Invalid reader notes'); noteKeys.add(note.key) }
    const references = result.nodes.map(node => memberNodeReference(String(node.key), reportId, editionId)).filter(ref => ref !== null)
    const nodeIds = new Set(references.map(ref => ref.nodeId)), collectionIds = new Set(references.map(ref => ref.collectionId)), annotationIds = new Set<string>()
    for (const annotation of reader.annotations) {
      if (!object(annotation) || typeof annotation.id !== 'string' || annotationIds.has(annotation.id) || typeof annotation.subjectId !== 'string' || !['collection', 'node'].includes(String(annotation.subjectType)) || typeof annotation.type !== 'string' || !nullableText(annotation.format) || !('value' in annotation) || (annotation.subjectType === 'node' && !nodeIds.has(annotation.subjectId)) || (annotation.subjectType === 'collection' && collectionIds.size > 0 && !collectionIds.has(annotation.subjectId))) throw new MemberDigestError(502, 'Invalid reader annotations')
      annotationIds.add(annotation.id)
    }
  }
  return result as MemberDigestIssue
}
export function safeMemberHref(value: unknown): string | null { if (typeof value !== 'string') return null; try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
export async function getSharedMemberDigests(options: { cursor?: string; signal?: AbortSignal } = {}): Promise<{ items: MemberDigestSource[]; nextCursor: string | null }> {
  const suffix = options.cursor ? '?cursor=' + encodeURIComponent(options.cursor) : '?sourceType=digest_series&relation=shared'
  // The sources listing is gated behind the bookmark-subscription feature and
  // answers 404 while it is off: nothing is shared through it, not an error.
  const result = await read('/api/v1/me/bookmark-subscription-sources' + suffix, options.signal).catch(error => { if (error instanceof MemberDigestError && error.status === 404) return { items: [], nextCursor: null }; throw error })
  if (!object(result) || !Array.isArray(result.items) || !result.items.every(source) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new MemberDigestError(502)
  return result as { items: MemberDigestSource[]; nextCursor: string | null }
}
