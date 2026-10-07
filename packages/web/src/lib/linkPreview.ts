/**
 * LP-06: bookmark preview covers. The server only ever sends its own
 * `/api/v1/link-preview/{uuid}` objects; anything else is dropped so a card
 * never hotlinks a third party, whatever a stale or foreign payload says.
 */
export type PreviewCover = {
  readonly url: string
  readonly width: number
  readonly height: number
}

const LINK_PREVIEW_PATH = /^\/api\/v1\/link-preview\/[a-f0-9-]{36}$/
const MAX_SIDE = 4096

export function previewCover(value: unknown): PreviewCover | null {
  if (value === null || typeof value !== 'object') return null
  const { url, width, height } = value as Record<string, unknown>
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null
  if (!isSide(width) || !isSide(height)) return null
  try {
    const parsed = new URL(url)
    if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return null
    if (!LINK_PREVIEW_PATH.test(parsed.pathname)) return null
    const sameOrigin = typeof window !== 'undefined' && parsed.origin === window.location.origin
    if (!sameOrigin && parsed.protocol !== 'https:') return null
    return { url: parsed.href, width, height }
  } catch {
    return null
  }
}

function isSide(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SIDE
}
