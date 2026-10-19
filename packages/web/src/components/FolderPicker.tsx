import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'

export type FolderPickerOption = {
  id: string
  title: string
  /** 0 for a top-level folder; each child is one deeper than its parent. */
  depth: number
}

type Row = FolderPickerOption & {
  /** Ancestor titles, outermost first. */
  trail: readonly string[]
}

/** Ancestor titles from a tree-order list (parents before children). */
function withTrails(folders: readonly FolderPickerOption[]): Row[] {
  const stack: string[] = []
  return folders.map((folder) => {
    stack.length = Math.min(stack.length, folder.depth)
    const row = { ...folder, trail: [...stack] }
    stack.push(folder.title)
    return row
  })
}

type Props = {
  /** The toggle's id: a field label's htmlFor and focus-on-error point here. */
  id: string
  /** Folders in tree order, parents before children. */
  folders: readonly FolderPickerOption[]
  value: string
  onChange(id: string): void
  /** Recently used folders, newest first; a Recent group leads the list while nothing is searched. */
  recentIds?: readonly string[]
  /** The field label's id; the toggle reads it before the chosen folder. */
  labelledBy?: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
}

/**
 * The browser extension's folder picker, for the web: a toggle names the
 * chosen folder (its parents muted before it) and opens an inline panel with
 * a search field and the folders as an indented tree in the library's own
 * order. Recently used folders lead in their own group; a search lists the
 * matches flat, each with its path. A pick applies at once and closes the
 * panel.
 */
export function FolderPicker({
  id,
  folders,
  value,
  onChange,
  recentIds = [],
  labelledBy,
  placeholder = 'Choose a folder',
  disabled = false,
  invalid = false,
  describedBy,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => withTrails(folders), [folders])
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const chosen = byId.get(value) ?? null
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle ? rows.filter((row) => row.title.toLocaleLowerCase().includes(needle)) : rows
  const recent = needle ? [] : recentIds.flatMap((recentId) => byId.get(recentId) ?? [])
  const panelId = `${id}-panel`
  const currentId = `${id}-current`

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // Opening lands in the search field. The list starts at the Recent group,
  // else at the chosen folder; only opening scrolls it, never a search.
  const hasRecentRef = useRef(false)
  hasRecentRef.current = recent.length > 0
  useEffect(() => {
    if (!open) return
    searchRef.current?.focus({ preventScroll: true })
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (list && selected && !hasRecentRef.current) list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2
    rootRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  const close = () => {
    setOpen(false)
    toggleRef.current?.focus()
  }
  const pick = (folderId: string) => {
    onChange(folderId)
    close()
  }

  /* Listbox keys as in the extension: arrows, Home and End roam the rows,
     ArrowDown leaves the search for the first row and ArrowUp returns to it,
     Enter in the search takes the first match, Escape closes the panel
     without closing a dialog around it. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    if (event.target === searchRef.current) {
      if (event.key === 'Enter') {
        // The panel sits inside forms; Enter here must never submit one.
        event.preventDefault()
        const first = options[0]?.dataset.folderId
        if (needle && first) pick(first)
      } else if (event.key === 'ArrowDown' && options[0]) {
        event.preventDefault()
        options[0].focus()
      }
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || options.length === 0) return
    event.preventDefault()
    const from = options.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowUp' && from <= 0) {
      searchRef.current?.focus()
      return
    }
    const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, from + 1)
      : event.key === 'ArrowUp' ? from - 1
        : event.key === 'Home' ? 0
          : options.length - 1
    options[next]?.focus()
  }

  // Roving tabindex: the chosen folder's first row (else the first row) is the one tab stop.
  const stopKey = (() => {
    const list = [...recent.map((row) => `recent:${row.id}`), ...matches.map((row) => `all:${row.id}`)]
    return list.find((key) => key.endsWith(`:${value}`)) ?? list[0]
  })()
  const option = (row: Row, group: 'recent' | 'all') => {
    const key = `${group}:${row.id}`
    // Recent rows and search matches sit flat; the tree indents by depth.
    const flat = group === 'recent' || needle !== ''
    return (
      <button
        key={key}
        type="button"
        role="option"
        className="folder-opt"
        data-folder-id={row.id}
        aria-selected={row.id === value}
        tabIndex={key === stopKey ? 0 : -1}
        title={[...row.trail, row.title].join(' › ')}
        style={flat ? undefined : { ['--depth' as string]: String(row.depth) }}
        onClick={() => pick(row.id)}
      >
        <Icon name="folder" />
        <span className="folder-opt-label">
          {row.title}
          {flat && row.trail.length > 0 && <span className="folder-opt-trail">{row.trail.join(' › ')}</span>}
        </span>
        {row.id === value && <Icon name="check" className="folder-opt-check" />}
      </button>
    )
  }

  return (
    <div className="folder-picker" ref={rootRef}>
      <button
        ref={toggleRef}
        id={id}
        type="button"
        className="folder-pill"
        value={value}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${currentId}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => {
          setQuery('')
          setOpen((was) => !was)
        }}
      >
        <Icon name="folder" />
        <span id={currentId} className="folder-pill-current">
          {chosen ? <>
            {chosen.trail.length > 0 && <span className="folder-pill-trail">{chosen.trail.join(' › ')} ›</span>}
            <span className="folder-pill-name">{chosen.title}</span>
          </> : <span className="folder-pill-placeholder">{placeholder}</span>}
        </span>
        <Icon name="chevron-down" className="folder-pill-chevron" />
      </button>
      {open && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- keys for the search field and the listbox rows inside it
        <div id={panelId} className="folder-panel" onKeyDown={onKeyDown}>
          <label className="folder-search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              autoComplete="off"
              placeholder="Search folders"
              aria-label="Search folders"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div ref={listRef} className="folder-list" role="listbox" aria-label="Folders">
            {recent.length > 0 ? <>
              <div role="group" aria-labelledby={`${id}-recent`}>
                <p id={`${id}-recent`} className="folder-group">Recent</p>
                {recent.map((row) => option(row, 'recent'))}
              </div>
              <div role="group" aria-labelledby={`${id}-all`}>
                <p id={`${id}-all`} className="folder-group">All folders</p>
                {matches.map((row) => option(row, 'all'))}
              </div>
            </> : matches.map((row) => option(row, 'all'))}
          </div>
          {matches.length === 0 && (
            <p className="folder-empty">{needle ? 'No folders match.' : 'No folders yet.'}</p>
          )}
        </div>
      )}
    </div>
  )
}
