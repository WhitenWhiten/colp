import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
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

type Tree = {
  rows: Row[]
  byId: Map<string, number>
  /** Per row: its parent's index (-1 at the top), the index after its subtree, its direct subfolder count. */
  parents: number[]
  ends: number[]
  childCounts: number[]
}

/** One pass over a tree-order list (parents before children). */
function indexTree(folders: readonly FolderPickerOption[]): Tree {
  const rows: Row[] = []
  const parents: number[] = []
  const ends = folders.map(() => folders.length)
  const childCounts = folders.map(() => 0)
  const titles: string[] = []
  const stack: number[] = []
  folders.forEach((folder, at) => {
    while (stack.length > 0 && folders[stack.at(-1)!]!.depth >= folder.depth) ends[stack.pop()!] = at
    titles.length = Math.min(titles.length, folder.depth)
    rows.push({ ...folder, trail: [...titles] })
    titles.push(folder.title)
    parents[at] = stack.at(-1) ?? -1
    if (parents[at]! >= 0) childCounts[parents[at]!]! += 1
    stack.push(at)
  })
  return { rows, byId: new Map(rows.map((row, at) => [row.id, at])), parents, ends, childCounts }
}

/** Rows a branch opens to before a long tree stays folded at its first level. */
const OPEN_BUDGET = 12

/** The chosen folder's ancestors, open. */
function withBranch(open: ReadonlySet<string>, tree: Tree, id: string): Set<string> {
  const next = new Set(open)
  for (let at = tree.parents[tree.byId.get(id) ?? -1] ?? -1; at >= 0; at = tree.parents[at]!) next.add(tree.rows[at]!.id)
  return next
}

/* Level by level, the way a reader scans: the top level always opens; the
   next level opens only while everything shown still fits the budget. */
function seedExpanded(tree: Tree, chosen: string): Set<string> {
  const open = new Set<string>()
  let shown = tree.rows.filter((row) => row.depth === 0).length
  for (let depth = 0; ; depth += 1) {
    const level = tree.rows.flatMap((row, at) => (row.depth === depth && tree.childCounts[at]! > 0 ? [at] : []))
    if (level.length === 0) break
    const adds = level.reduce((sum, at) => sum + tree.childCounts[at]!, 0)
    if (depth > 0 && shown + adds > OPEN_BUDGET) break
    for (const at of level) open.add(tree.rows[at]!.id)
    shown += adds
  }
  return withBranch(open, tree, chosen)
}

type Shown = {
  key: string
  at: number
  /** aria-level − 1, and the indent. */
  level: number
  /** Set when the row has subfolders. */
  open?: boolean
  /** Recent rows and search matches name their parents. */
  trail?: boolean
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
 * a search field and the folders as a tree in the library's own order. A
 * chevron folds each branch: a short tree opens fully, a long one opens its
 * top level and the chosen folder's branch. Recently used folders lead in
 * their own group, each naming its parents and opening onto its own
 * subfolders; a search lists the matches flat, each with its path. A pick
 * applies at once and closes the panel.
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
  // Seeded on the first opening; later openings keep what the owner opened and add the chosen branch.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null)
  const [recentOpen, setRecentOpen] = useState<ReadonlySet<string>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const tree = useMemo(() => indexTree(folders), [folders])
  const { rows, byId, ends, childCounts } = tree
  const chosen = rows[byId.get(value) ?? -1] ?? null
  const needle = query.trim().toLocaleLowerCase()
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

  // Opening lands in the search field and brings the chosen folder into the
  // list's view, unless Recent already shows it at the top. Only opening
  // scrolls the list, never a search or a fold.
  useEffect(() => {
    if (!open) return
    searchRef.current?.focus({ preventScroll: true })
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (list && selected && !selected.closest('[data-folder-group="recent"]')) {
      list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2
    }
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

  const shown: { recent: Shown[]; all: Shown[] } = { recent: [], all: [] }
  if (needle) {
    rows.forEach((row, at) => {
      if (row.title.toLocaleLowerCase().includes(needle)) shown.all.push({ key: `match:${row.id}`, at, level: 0, trail: true })
    })
  } else {
    const isOpen = expanded ?? new Set<string>()
    for (let at = 0; at < rows.length;) {
      const branch = childCounts[at]! > 0
      const unfolded = branch && isOpen.has(rows[at]!.id)
      shown.all.push({ key: `all:${rows[at]!.id}`, at, level: rows[at]!.depth, ...(branch ? { open: unfolded } : {}) })
      at = unfolded || !branch ? at + 1 : ends[at]!
    }
    // A recent folder with subfolders opens onto them in place.
    for (const recentId of recentIds) {
      const top = byId.get(recentId)
      if (top === undefined) continue
      const visit = (at: number, isTop: boolean) => {
        const key = `${recentId}/${rows[at]!.id}`
        const branch = childCounts[at]! > 0
        const unfolded = branch && recentOpen.has(key)
        shown.recent.push({ key: `recent:${key}`, at, level: rows[at]!.depth - rows[top]!.depth,
          ...(branch ? { open: unfolded } : {}), ...(isTop ? { trail: true } : {}) })
        if (unfolded) for (let child = at + 1; child < ends[at]!; child = ends[child]!) visit(child, false)
      }
      visit(top, true)
    }
  }

  const fold = (item: Shown, next: boolean) => {
    const update = (was: ReadonlySet<string> | null, ref: string) => {
      const set = new Set(was)
      if (next) set.add(ref)
      else set.delete(ref)
      return set
    }
    if (item.key.startsWith('recent:')) setRecentOpen((was) => update(was, item.key.slice('recent:'.length)))
    else setExpanded((was) => update(was, rows[item.at]!.id))
  }

  const onRowClick = (event: MouseEvent<HTMLButtonElement>, row: Shown) => {
    // The chevron opens and folds; the rest of the row picks.
    if (row.open !== undefined && (event.target as Element).closest('[data-twisty]')) {
      event.currentTarget.focus({ preventScroll: true })
      fold(row, !row.open)
      return
    }
    pick(rows[row.at]!.id)
  }

  /* Tree keys, as in the extension: arrows, Home and End roam the rows,
     ArrowRight opens a branch (then steps into it), ArrowLeft folds it (then
     climbs to the parent), typing on a row goes to the search, ArrowDown
     leaves the search for the first row and ArrowUp returns to it, Enter in
     the search takes the first match, Escape closes the panel without closing
     a dialog around it. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])]
    if (event.target === searchRef.current) {
      if (event.key === 'Enter') {
        // The panel sits inside forms; Enter here must never submit one.
        event.preventDefault()
        const first = items[0]?.dataset.folderId
        if (needle && first) pick(first)
      } else if (event.key === 'ArrowDown' && items[0]) {
        event.preventDefault()
        items[0].focus()
      }
      return
    }
    const from = items.indexOf(document.activeElement as HTMLButtonElement)
    if (from < 0) return
    const current = items[from]!
    const row = [...shown.recent, ...shown.all].find((item) => item.key === current.dataset.key)
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        items[Math.min(items.length - 1, from + 1)]?.focus()
        return
      case 'ArrowUp':
        event.preventDefault()
        if (from === 0) searchRef.current?.focus()
        else items[from - 1]?.focus()
        return
      case 'Home':
        event.preventDefault()
        items[0]?.focus()
        return
      case 'End':
        event.preventDefault()
        items.at(-1)?.focus()
        return
      case 'ArrowRight':
        event.preventDefault()
        if (row?.open === false) fold(row, true)
        else if (row?.open === true) items[from + 1]?.focus()
        return
      case 'ArrowLeft': {
        event.preventDefault()
        if (row?.open === true) {
          fold(row, false)
          return
        }
        const level = Number(current.getAttribute('aria-level'))
        for (let at = from - 1; at >= 0; at -= 1) {
          if (Number(items[at]!.getAttribute('aria-level')) < level) {
            items[at]!.focus()
            return
          }
        }
        return
      }
      default:
        if (event.key.length === 1 && event.key !== ' ') {
          event.preventDefault()
          setQuery((was) => was + event.key)
          searchRef.current?.focus()
        }
    }
  }

  // Roving tabindex: the chosen folder's first row (else the first row) is the one tab stop.
  const stopKey = (() => {
    const order = [...shown.recent, ...shown.all]
    return (order.find((row) => rows[row.at]!.id === value) ?? order[0])?.key
  })()
  const option = (item: Shown) => {
    const row = rows[item.at]!
    // Search matches sit flat; the tree and Recent's subfolders indent by level.
    const flat = needle !== ''
    return (
      <button
        key={item.key}
        type="button"
        role="treeitem"
        className="folder-opt"
        data-folder-id={row.id}
        data-key={item.key}
        aria-level={item.level + 1}
        aria-selected={row.id === value}
        aria-expanded={item.open}
        tabIndex={item.key === stopKey ? 0 : -1}
        title={[...row.trail, row.title].join(' › ')}
        style={flat ? undefined : { ['--depth' as string]: String(item.level) }}
        onClick={(event) => onRowClick(event, item)}
      >
        <span className="folder-twisty" data-twisty aria-hidden="true">{item.open !== undefined && <Icon name="chevron-right" />}</span>
        <Icon name="folder" />
        <span className="folder-opt-label">
          <span className="folder-opt-name">{row.title}</span>
          {item.trail && row.trail.length > 0 && <span className="folder-opt-trail">{row.trail.join(' › ')}</span>}
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
        aria-haspopup="tree"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${currentId}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => {
          setQuery('')
          if (!open) setExpanded((was) => (was ? withBranch(was, tree, value) : seedExpanded(tree, value)))
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
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- keys for the search field and the tree rows inside it
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
          <div ref={listRef} className="folder-list" role="tree" aria-label="Folders">
            {shown.recent.length > 0 ? <>
              <div role="group" data-folder-group="recent" aria-labelledby={`${id}-recent`}>
                <p id={`${id}-recent`} className="folder-group">Recent</p>
                {shown.recent.map(option)}
              </div>
              <div role="group" data-folder-group="all" aria-labelledby={`${id}-all`}>
                <p id={`${id}-all`} className="folder-group">All folders</p>
                {shown.all.map(option)}
              </div>
            </> : shown.all.map(option)}
          </div>
          {shown.all.length === 0 && (
            <p className="folder-empty">{needle ? 'No folders match.' : 'No folders yet.'}</p>
          )}
        </div>
      )}
    </div>
  )
}
