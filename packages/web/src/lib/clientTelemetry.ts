import { apiUrl } from '../api/config'

/**
 * R15-13: client error reporting and real-user Web Vitals, sent to the
 * first-party POST /api/v1/client-events (D-43). Events carry the route
 * template (for example /c/:slug), the build and nothing else about the
 * visitor: no URL, slug, handle, query or account id. Production builds only.
 */

export type ClientErrorSource = 'window_error' | 'unhandled_rejection' | 'render_error' | 'chunk_load_error'

type ClientEvent =
  | { kind: 'error'; source: ClientErrorSource; route: string; message: string; stack?: string }
  | { kind: 'vital'; name: 'LCP' | 'CLS' | 'INP'; value: number; rating: 'good' | 'needs-improvement' | 'poor'; route: string }

const ENDPOINT = '/api/v1/client-events'
const MAX_BATCH = 20
const FLUSH_DELAY_MS = 2_000
/** A crash loop must not become a beacon loop. */
const MAX_ERRORS_PER_PAGE = 25

/* Path words that are route structure, not user data. Every other segment
   (slugs, handles, ids) becomes `:param`. */
const LITERAL_SEGMENTS = new Set([
  'today', 'updates', 'explore', 'reports', 'search', 'feed', 'c', 'path', 'share', 'u', 'profile', 'r',
  'read', 'library', 'dashboard', 'login', 'consent', 'register', 'reset-password', 'verify-email', 'auth',
  'onboarding', 'graph', 'creator', 'settings', 'export', 'extension', 'sync', 'classify', 'import',
  'notifications', 'credits', 'community', 'moderation', 'admin', 'approvals', 'ai', 'about', 'contact',
  'privacy', 'mcp', 'developers', 'embed-guide', 'demo', 'demos', 'new', 'health', 'digests', 'issues',
  'edit', 'history', 'collaborators', 'following', 'comments', 'cases', 'appeals', 'batch', 'organize',
  'popup', 'recovery', 'chat',
])

export function routeTemplate(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).slice(0, 8)
  if (segments.length === 0) return '/'
  return `/${segments.map((segment) => (LITERAL_SEGMENTS.has(segment) ? segment : ':param')).join('/')}`
}

/** The entry chunk's content hash identifies the build. */
function releaseId(): string {
  const match = /-([A-Za-z0-9_-]{6,})\.js(?:$|\?)/u.exec(import.meta.url)
  return match?.[1]?.slice(0, 64) ?? 'dev'
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/* Stacks keep file:line:col but drop the origin, so no URL leaves the page. */
function scrubStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  return clip(stack.replace(/https?:\/\/[^\s/)]+/gu, ''), 4_000)
}

type Sender = (body: string) => void

const defaultSender: Sender = (body) => {
  void fetch(apiUrl(ENDPOINT), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    credentials: 'omit',
    keepalive: true,
  }).catch(() => undefined)
}

let queue: ClientEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let errorsThisPage = 0
let sender: Sender = defaultSender
let enabled = false

function flush() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  while (queue.length > 0) {
    const events = queue.slice(0, MAX_BATCH)
    queue = queue.slice(MAX_BATCH)
    try {
      sender(JSON.stringify({ release: releaseId(), events }))
    } catch {
      // Telemetry never breaks the page.
    }
  }
}

function enqueue(event: ClientEvent) {
  if (!enabled) return
  queue.push(event)
  if (queue.length >= MAX_BATCH) flush()
  else if (timer === null) timer = setTimeout(flush, FLUSH_DELAY_MS)
}

export function reportClientError(source: ClientErrorSource, error: unknown) {
  if (!enabled || errorsThisPage >= MAX_ERRORS_PER_PAGE) return
  errorsThisPage += 1
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === 'string' ? error : 'Non-error value thrown'
  const stack = error instanceof Error ? scrubStack(error.stack) : undefined
  enqueue({
    kind: 'error',
    source,
    route: routeTemplate(window.location.pathname),
    message: clip(message, 500),
    ...(stack ? { stack } : {}),
  })
}

function reportVital(metric: { name: string; value: number; rating: string }) {
  if (metric.name !== 'LCP' && metric.name !== 'CLS' && metric.name !== 'INP') return
  if (metric.rating !== 'good' && metric.rating !== 'needs-improvement' && metric.rating !== 'poor') return
  enqueue({
    kind: 'vital',
    name: metric.name,
    value: Math.max(0, Math.min(600_000, Math.round(metric.value * 10_000) / 10_000)),
    rating: metric.rating,
    route: routeTemplate(window.location.pathname),
  })
}

/** Installs the global handlers and Web Vitals once, in production builds. */
export function installClientTelemetry(options: { force?: boolean; send?: Sender } = {}) {
  if (enabled || (!import.meta.env.PROD && !options.force)) return
  enabled = true
  if (options.send) sender = options.send
  window.addEventListener('error', (event) => {
    reportClientError('window_error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError('unhandled_rejection', event.reason)
  })
  window.addEventListener('vite:preloadError', (event) => {
    reportClientError('chunk_load_error', (event as Event & { payload?: unknown }).payload)
  })
  // Send what is queued before the page goes away (tab switch, close, bfcache).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
  // Web Vitals load after first paint, off the critical path.
  void import('web-vitals').then(({ onCLS, onINP, onLCP }) => {
    onLCP(reportVital)
    onCLS(reportVital)
    onINP(reportVital)
  }).catch(() => undefined)
}

/** Test-only: drop state between cases. */
export function resetClientTelemetryForTests() {
  if (timer !== null) clearTimeout(timer)
  queue = []
  timer = null
  errorsThisPage = 0
  sender = defaultSender
  enabled = false
}

export function flushClientTelemetryForTests() {
  flush()
}
