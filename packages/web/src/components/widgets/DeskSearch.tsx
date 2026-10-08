import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../Icon'

type Engine = {
  id: string
  label: string
  /** External URL builder; omit for in-app Known search */
  buildUrl?: (q: string) => string
}

const DEFAULT_ENGINE: Engine = { id: 'known', label: 'Know-N' }
const ENGINES: Engine[] = [
  DEFAULT_ENGINE,
  {
    id: 'google',
    label: 'Google',
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'bing',
    label: 'Bing',
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'ddg',
    label: 'DuckDuckGo',
    buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'baidu',
    label: 'Baidu',
    buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  },
]

const ENGINE_KEY = 'known.desk.search.engine.v1'

function loadEngine(): string {
  try {
    const raw = localStorage.getItem(ENGINE_KEY)
    if (raw && ENGINES.some((e) => e.id === raw)) return raw
  } catch {
    /* ignore */
  }
  return 'known'
}

type Props = {
  resourceId: string
  editable?: boolean
}

export function DeskSearch({ resourceId, editable = false }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [engineId, setEngineId] = useState(loadEngine)

  useEffect(() => {
    try {
      localStorage.setItem(ENGINE_KEY, engineId)
    } catch {
      /* ignore */
    }
  }, [engineId])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    const engine = ENGINES.find((x) => x.id === engineId) ?? DEFAULT_ENGINE
    if (engine.buildUrl) {
      window.open(engine.buildUrl(q), '_blank', 'noopener,noreferrer')
    } else {
      navigate(`/search?q=${encodeURIComponent(q)}`)
    }
  }

  return (
    <div className="desk-widget desk-search" data-resource={resourceId}>
      <form className="desk-search-form" onSubmit={submit}>
        <label className="visually-hidden" htmlFor={`desk-q-${resourceId}`}>
          Search query
        </label>
        <div className="desk-search-field">
          <Icon name="search" className="desk-search-icon" />
          <input
            id={`desk-q-${resourceId}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the web or your library…"
            autoComplete="off"
            spellCheck={false}
          />
          {editable && (
            <label className="desk-search-engine-select">
              <span className="visually-hidden">Search engine</span>
              <select
                value={engineId}
                onChange={(event) => setEngineId(event.target.value)}
                aria-label="Search engine"
              >
                {ENGINES.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={!query.trim()}>
            Go
          </button>
        </div>
      </form>
    </div>
  )
}
