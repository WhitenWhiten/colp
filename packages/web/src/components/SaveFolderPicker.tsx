import { Link } from 'react-router-dom'
import { useOwnedCollections } from '../lib/useOwnedCollections'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Modal } from './Modal'

const SIGN_IN_MESSAGE = 'Sign in to view your collections'

type Props = {
  resourceTitle?: string
  currentFolder?: string | null
  onPick: (folder: string) => void
  onCancel: () => void
  onRemove?: () => void
  /** Visual density for board / list / compact */
  density?: 'card' | 'list' | 'compact'
}

/**
 * In-place picker: expand next to the shortlist control and ask which folder to use.
 * Not a silent success — user must choose a destination.
 * Options come from owned collections; the shortlist itself stays the caller's
 * device-local marks (R7-04: never phrase it as a library write).
 */
export function SaveFolderPicker({
  resourceTitle,
  currentFolder,
  onPick,
  onCancel,
  onRemove,
  density = 'list',
}: Props) {
  const owned = useOwnedCollections()
  const showList = owned.state === 'ready' && owned.items.length > 0
  // Signed-in users with zero collections get a way out instead of a dead end.
  const showCreateLink = owned.state === 'ready'
    && owned.items.length === 0
    && owned.message !== SIGN_IN_MESSAGE

  return (
    <Modal
      open
      onClose={onCancel}
      label="Shortlist for a folder"
      chrome="inline"
      panelClassName={`save-folder-picker save-folder-picker--${density}`}
      panelProps={{
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
      }}
    >
      <div className="save-folder-picker-head">
        <p className="save-folder-picker-title">
          {currentFolder ? 'Move shortlist' : 'Shortlist for a folder'}
        </p>
        {resourceTitle && (
          <p className="save-folder-picker-sub" title={resourceTitle}>
            {resourceTitle}
          </p>
        )}
        <p className="save-folder-picker-hint">
          Click a folder to shortlist — kept on this device until you file it in your library.
        </p>
      </div>
      {showList ? (
        <ul
          className="save-folder-list"
          role="listbox"
          aria-label="Your folders"
          onKeyDown={(event) => {
            /* APG listbox: arrows move focus between options, Home/End jump. */
            const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
            const from = options.indexOf(document.activeElement as HTMLElement)
            if (from < 0) return
            let next: number | null = null
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (from + 1) % options.length
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (from - 1 + options.length) % options.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = options.length - 1
            if (next === null || next === from) return
            event.preventDefault()
            options[next]?.focus({ preventScroll: true })
          }}
        >
          {owned.items.map((item) => {
            const title = item.collection.title
            const active = currentFolder === title
            return (
              <li key={item.collection.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`save-folder-item ${active ? 'is-active' : ''}`}
                  onClick={() => onPick(title)}
                >
                  <span className="save-folder-name">{title}</span>
                  <span className="save-folder-count">
                    {typeof item.bookmarkCount === 'number' ? item.bookmarkCount : ''}
                  </span>
                  {active && (
                    <span className="save-folder-check" aria-hidden>
                      <Icon name="check" />
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <EmptyState
          icon="folder"
          title={owned.message}
          role={owned.state === 'error' ? 'alert' : 'status'}
          action={showCreateLink ? (
            <Link to="/library/new" className="btn btn-secondary btn-sm">
              New collection
            </Link>
          ) : undefined}
        />
      )}
      <div className="save-folder-picker-foot">
        {currentFolder && onRemove && (
          <button type="button" className="btn btn-danger-ghost btn-sm save-folder-foot-start" onClick={onRemove}>
            Remove shortlist
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
