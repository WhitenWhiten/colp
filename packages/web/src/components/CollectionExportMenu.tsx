import { useState } from 'react'

export type CollectionExportFormat = 'html' | 'json'

export function filenameFromContentDisposition(header: string | null, fallback: string): string {
  if (header === null) return fallback
  const quoted = /filename="([^"]+)"/u.exec(header)
  const token = /filename=([^;\s]+)/u.exec(header)
  const raw = quoted?.[1] ?? token?.[1]
  if (raw === undefined) return fallback
  const name = raw.replace(/[^A-Za-z0-9._-]/gu, '')
  return name.length > 0 ? name : fallback
}

export async function downloadCollectionExport(
  collectionId: string,
  slug: string,
  format: CollectionExportFormat,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(
    `/api/v1/collections/${encodeURIComponent(collectionId)}/export?format=${format}`,
    { credentials: 'include' },
  )
  if (!response.ok) {
    throw new Error(`Export failed (${response.status}).`)
  }
  const blob = await response.blob()
  const filename = filenameFromContentDisposition(
    response.headers.get('Content-Disposition'),
    `${slug}.${format}`,
  )
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function CollectionExportMenu({
  collectionId,
  slug,
  download = downloadCollectionExport,
}: {
  readonly collectionId: string
  readonly slug: string
  readonly download?: (
    collectionId: string,
    slug: string,
    format: CollectionExportFormat,
  ) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (format: CollectionExportFormat) => {
    setError(null)
    void download(collectionId, slug, format).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Export failed.')
    })
  }
  return (
    <span className="export-menu">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        Export
      </button>
      {open ? (
        <span role="menu" aria-label="Export collection">
          <button type="button" role="menuitem" onClick={() => run('html')}>HTML</button>
          <button type="button" role="menuitem" onClick={() => run('json')}>JSON</button>
        </span>
      ) : null}
      {error !== null ? <span role="alert">{error}</span> : null}
    </span>
  )
}
