import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { SelectMenu } from '../../components/SelectMenu'
import { addTags, TagInput } from '../../components/TagInput'
import { plural, pluralNoun } from '../../lib/plural'
import { countTags, tagKey, toggleTag, type TagCount, type TagMatch } from '../../lib/libraryTags'

/** Tags shown in the sidebar before "All tags" takes over. */
export const SIDEBAR_TAG_LIMIT = 12

export type LibraryTagFilter = {
  /** Every tag in the open collection, most used first. */
  counts: TagCount[]
  selected: string[]
  match: TagMatch
  set: (tags: string[], match?: TagMatch) => void
  isSelected: (tag: string) => boolean
}

const MATCH_OPTIONS = [
  { value: 'all', label: 'All tags' },
  { value: 'any', label: 'Any tag' },
] as const

/** Sidebar section: the collection's most used tags, one toggle per row. */
export function LibraryTagSection({ filter, collapsed, onToggle, onShowAll }: {
  filter: LibraryTagFilter
  collapsed: boolean
  onToggle: () => void
  onShowAll: () => void
}) {
  const bodyId = useId()
  const { counts } = filter
  if (counts.length === 0) return null
  // Selected tags stay visible even when they fall outside the top rows.
  const top = counts.slice(0, SIDEBAR_TAG_LIMIT)
  const rows = [...top, ...counts.filter((entry) => filter.isSelected(entry.tag) && !top.includes(entry))]
  return (
    <section className="library-nav-section" data-testid="library-nav-tags">
      <h2 className="library-nav-section-head">
        <button
          type="button"
          className="library-nav-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
          <span>Tags</span>
        </button>
      </h2>
      {!collapsed && (
        <div id={bodyId} className="library-nav-section-body library-nav-tags" role="list" aria-label="Tags">
          {rows.map(({ tag, count }) => {
            const on = filter.isSelected(tag)
            return (
              <div role="listitem" key={tagKey(tag)} className="library-nav-branch">
                <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
                <button
                  type="button"
                  className={on ? 'library-nav-row library-nav-row--child is-current' : 'library-nav-row library-nav-row--child'}
                  aria-pressed={on}
                  data-tag={tag}
                  data-count={count}
                  onClick={() => filter.set(toggleTag(filter.selected, tag))}
                >
                  <span className="library-nav-icon library-nav-hash" aria-hidden>#</span>
                  <span className="library-nav-label" title={tag}>{tag}</span>
                  <span className="library-nav-count">
                    {count}
                    <span className="visually-hidden"> {pluralNoun(count, 'bookmark')}</span>
                  </span>
                </button>
              </div>
            )
          })}
          {counts.length > SIDEBAR_TAG_LIMIT && (
            <div className="library-nav-branch">
              <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
              <button type="button" className="library-nav-row library-nav-row--child library-nav-more-tags" onClick={onShowAll}>
                <span className="library-nav-label">All tags ({counts.length})…</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Searchable list of every tag; checking one filters the desk right away. */
export function LibraryTagPicker({ open, onClose, filter }: {
  open: boolean
  onClose: () => void
  filter: LibraryTagFilter
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () => (needle ? filter.counts.filter(({ tag }) => tag.toLowerCase().includes(needle)) : filter.counts),
    [filter.counts, needle],
  )
  return (
    <Modal
      open={open}
      onClose={() => { setQuery(''); onClose() }}
      label="Tags"
      title="Tags"
      size="sm"
      overlayProps={{ 'data-testid': 'library-tag-picker' }}
    >
      <div className="library-tag-picker">
        <label className="search-field search-field--compact">
          <span className="visually-hidden">Find a tag</span>
          <Icon name="search" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a tag…" autoComplete="off" />
        </label>
        {shown.length === 0 ? (
          <p className="library-tag-picker-empty">No tags match.</p>
        ) : (
          <ul className="library-tag-picker-list" aria-label="Tags">
            {shown.map(({ tag, count }) => (
              <li key={tagKey(tag)}>
                <label className="library-tag-picker-row">
                  <input
                    type="checkbox"
                    checked={filter.isSelected(tag)}
                    onChange={() => filter.set(toggleTag(filter.selected, tag))}
                  />
                  <span className="library-tag-picker-name">#{tag}</span>
                  <span className="library-tag-picker-count">{count}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="row-end">
          {filter.selected.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => filter.set([])}>Clear tags</button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { setQuery(''); onClose() }}>Done</button>
        </div>
      </div>
    </Modal>
  )
}

/** The active tags above the rows: one removable token each, and the match rule once two are chosen. */
export function LibraryTagFilterBar({ filter }: { filter: LibraryTagFilter }) {
  if (filter.selected.length === 0) return null
  return (
    <div className="library-tag-filter" data-testid="library-tag-filter" role="group" aria-label="Tag filter">
      {filter.selected.map((tag) => (
        <span className="chip library-tag-token" key={tagKey(tag)}>
          #{tag}
          <button
            type="button"
            className="library-tag-token-remove"
            aria-label={`Remove tag filter ${tag}`}
            onClick={() => filter.set(toggleTag(filter.selected, tag))}
          >
            <Icon name="cross" />
          </button>
        </span>
      ))}
      {filter.selected.length > 1 && (
        <SelectMenu
          label="Match"
          prefix="Match:"
          value={filter.match}
          options={MATCH_OPTIONS}
          onChange={(match) => filter.set(filter.selected, match)}
          testId="library-tag-match"
        />
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => filter.set([])}>Clear</button>
    </div>
  )
}

type TagState = 'on' | 'off' | 'mixed'

/** A checkbox that can also show "some of them" (aria-checked="mixed"). */
function TriStateBox({ state, onChange }: { state: TagState; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'mixed' }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'on'}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      onChange={onChange}
    />
  )
}

/**
 * Bulk tagging for the selection. Each tag already on a selected bookmark is a
 * checkbox: checked when every bookmark has it, mixed when some do. Checking
 * adds it to all, clearing removes it from all, and a mixed tag can go back to
 * mixed to stay as it is. New tags typed below are added to every bookmark.
 */
export function LibraryBulkTagDialog({ nodes, vocabulary, onApply, onClose }: {
  /** The selected bookmarks; null while the dialog is closed. */
  nodes: ReadonlyArray<{ tags: readonly string[] }> | null
  vocabulary: TagCount[]
  onApply: (change: { add: string[]; remove: string[] }) => void
  onClose: () => void
}) {
  const present = useMemo(() => countTags(nodes ?? []), [nodes])
  const initial = (count: number): TagState => (count === (nodes?.length ?? 0) ? 'on' : 'mixed')
  const [states, setStates] = useState<Record<string, TagState>>({})
  const [added, setAdded] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  useEffect(() => { setStates({}); setAdded([]); setDraft('') }, [nodes])

  const stateOf = (tag: string, count: number) => states[tagKey(tag)] ?? initial(count)
  const cycle = (tag: string, count: number) => {
    const start = initial(count)
    const order: TagState[] = start === 'mixed' ? ['mixed', 'on', 'off'] : ['on', 'off']
    const now = stateOf(tag, count)
    setStates((current) => ({ ...current, [tagKey(tag)]: order[(order.indexOf(now) + 1) % order.length]! }))
  }

  const apply = () => {
    const add = addTags(added, [draft], vocabulary)
    const remove: string[] = []
    for (const { tag, count } of present) {
      const state = stateOf(tag, count)
      if (state === 'off') remove.push(tag)
      else if (state === 'on' && initial(count) === 'mixed') add.push(tag)
    }
    onApply({ add, remove })
  }

  const total = nodes?.length ?? 0
  return (
    <Modal
      open={nodes !== null}
      onClose={onClose}
      label="Tag bookmarks"
      title={`Tag ${plural(total, 'bookmark')}`}
      size="sm"
      overlayProps={{ 'data-testid': 'library-bulk-tag' }}
    >
      <div className="library-tag-picker">
        {present.length > 0 && (
          <ul className="library-tag-picker-list" aria-label="Tags on the selected bookmarks">
            {present.map(({ tag, count }) => (
              <li key={tagKey(tag)}>
                <label className="library-tag-picker-row">
                  <TriStateBox state={stateOf(tag, count)} onChange={() => cycle(tag, count)} />
                  <span className="library-tag-picker-name">#{tag}</span>
                  <span className="library-tag-picker-count">{count === total ? 'All' : `${count} of ${total}`}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="field">
          <label htmlFor="library-bulk-tag-add">Add tags</label>
          <TagInput
            id="library-bulk-tag-add"
            tags={added}
            onTagsChange={setAdded}
            draft={draft}
            onDraftChange={setDraft}
            vocabulary={vocabulary}
          />
        </div>
        <div className="row-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={apply}>Apply</button>
        </div>
      </div>
    </Modal>
  )
}
