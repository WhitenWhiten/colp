/**
 * Product API origin for the browser client.
 *
 * - `VITE_API_ORIGIN` — absolute origin, e.g. `http://localhost:3000` (no trailing slash)
 * - unset / empty — relative `/` paths (same-origin deploy or Vite dev proxy)
 *
 * See README "API origin" section.
 */
export function getApiBaseUrl(): string {
  try {
    const raw = import.meta.env?.VITE_API_ORIGIN
    if (typeof raw === 'string' && raw.trim()) {
      return raw.replace(/\/$/, '')
    }
  } catch {
    /* non-vite */
  }
  return ''
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl()
  const p = path.startsWith('/') ? path : `/${path}`
  return base ? `${base}${p}` : p
}
