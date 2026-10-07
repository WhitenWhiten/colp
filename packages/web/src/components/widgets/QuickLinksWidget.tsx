import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDeskStorage } from '../../lib/useDeskStorage'
import { Icon } from '../Icon'

type QuickLink = {
  id: string
  label: string
  href: string
}

type Props = { resourceId: string }

const LIVE_PATH_HREF = '/path/llm-learning-path'
const LEGACY_PATH_HREF = '/path/interface-systems'

const DEFAULTS: QuickLink[] = [
  { id: 'ql1', label: 'Library', href: '/library' },
  { id: 'ql2', label: 'Classify', href: '/classify' },
  { id: 'ql3', label: 'Feed', href: '/feed' },
  { id: 'ql4', label: 'Explore', href: '/explore' },
  { id: 'ql5', label: 'Sync', href: '/sync' },
  { id: 'ql6', label: 'Path', href: LIVE_PATH_HREF },
]

function storageKey(id: string) {
  return `known.desk.quicklinks.${id}.v1`
}

function newId() {
  return `ql-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function fallbackLinks(): QuickLink[] {
  return DEFAULTS.map((l) => ({ ...l }))
}

function normalizeLinks(stored: unknown, id: string): QuickLink[] {
  const parsed = stored as QuickLink[]
  if (!Array.isArray(parsed) || !parsed.length) return fallbackLinks()
  const links = parsed
    .filter((l) => l && typeof l.label === 'string' && typeof l.href === 'string')
    .map((l) => ({
      id: typeof l.id === 'string' ? l.id : newId(),
      label: l.label.slice(0, 32),
      href: l.href.slice(0, 240),
    }))
  let migrated = false
  const next = links.map((l) => {
    if (l.href !== LEGACY_PATH_HREF) return l
    migrated = true
    return { ...l, href: LIVE_PATH_HREF }
  })
  if (migrated) {
    try {
      localStorage.setItem(storageKey(id), JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }
  return next
}

function isExternal(href: string) {
  return /^https?:\/\//i.test(href)
}

export function QuickLinksWidget({ resourceId }: Props) {
  const { value: links, set: setLinks } = useDeskStorage<QuickLink[]>({
    storageKey: storageKey(resourceId),
    fallback: fallbackLinks,
    normalize: (stored) => normalizeLinks(stored, resourceId),
  })
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState('')
  const [href, setHref] = useState('')

  useEffect(() => {
    setEditing(false)
  }, [resourceId])

  const add = () => {
    const l = label.trim()
    const h = href.trim() || '/'
    if (!l) return
    setLinks([...links, { id: newId(), label: l, href: h }])
    setLabel('')
    setHref('')
  }

  const remove = (id: string) => {
    setLinks(links.filter((x) => x.id !== id))
  }

  return (
    <div className="desk-widget desk-quicklinks" data-resource={resourceId}>
      <div className="desk-widget-head">
        <span className="desk-widget-title">Quick links</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      <div className="desk-ql-grid">
        {links.map((l) => (
          <div key={l.id} className="desk-ql-item">
            {isExternal(l.href) ? (
              <a className="desk-ql-chip" href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ) : (
              <Link className="desk-ql-chip" to={l.href}>
                {l.label}
              </Link>
            )}
            {editing && (
              <button
                type="button"
                className="desk-ql-remove"
                aria-label={`Remove ${l.label}`}
                onClick={() => remove(l.id)}
              >
                <Icon name="cross" />
              </button>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <form
          className="desk-ql-add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label"
            aria-label="Link label"
            maxLength={32}
          />
          <input
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder="/path or https://…"
            aria-label="Link URL"
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!label.trim()}>
            Add
          </button>
        </form>
      )}
    </div>
  )
}
