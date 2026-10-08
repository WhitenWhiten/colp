import { useEffect, useId, useState } from 'react'
import { useDeskStorage } from '../../lib/useDeskStorage'
import { Icon } from '../Icon'

type TodoItem = {
  id: string
  text: string
  done: boolean
}

type TodoState = {
  title: string
  items: TodoItem[]
}

type Props = {
  resourceId: string
  defaultTitle?: string
}

function storageKey(id: string) {
  return `known.desk.todo.${id}.v1`
}

function newId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function TodoWidget({ resourceId, defaultTitle = 'Today' }: Props) {
  const baseId = useId()
  const { value: state, update } = useDeskStorage<TodoState>({
    storageKey: storageKey(resourceId),
    fallback: () => ({
      title: defaultTitle,
      items: [
        { id: newId(), text: 'Triage open tabs', done: false },
        { id: newId(), text: 'Capture one idea to a collection', done: false },
      ],
    }),
    /* Corrupt JSON historically meant an empty list, not the seed items. */
    onCorrupt: () => ({ title: defaultTitle, items: [] }),
    normalize: (stored) => {
      const parsed = stored as TodoState
      if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.items)) {
        return { title: defaultTitle, items: [] }
      }
      return {
        title: parsed.title || defaultTitle,
        items: parsed.items
          .filter((it) => it && typeof it.id === 'string' && typeof it.text === 'string')
          .map((it) => ({
            id: it.id,
            text: it.text,
            done: Boolean(it.done),
          })),
      }
    },
  })
  const [editingTitle, setEditingTitle] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setEditingTitle(false)
    setDraft('')
  }, [resourceId, defaultTitle])

  const addItem = () => {
    const text = draft.trim()
    if (!text) return
    update((prev) => ({
      ...prev,
      items: [...prev.items, { id: newId(), text, done: false }],
    }))
    setDraft('')
  }

  const remaining = state.items.filter((i) => !i.done).length

  return (
    <div className="desk-widget">
      <div className="desk-widget-head">
        {editingTitle ? (
          <input
            className="desk-todo-title-input"
            value={state.title}
            aria-label="Todo list title"
            autoFocus
            onChange={(e) => update((prev) => ({ ...prev, title: e.target.value }))}
            onBlur={() => {
              setEditingTitle(false)
              if (!state.title.trim()) {
                update((prev) => ({ ...prev, title: defaultTitle }))
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.currentTarget.blur()
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="desk-todo-title-btn"
            onClick={() => setEditingTitle(true)}
            title="Rename list"
          >
            <span className="desk-widget-title">{state.title || defaultTitle}</span>
            <span className="desk-todo-edit-hint" aria-hidden>
              Rename
            </span>
          </button>
        )}
        <span className="desk-todo-count meta">
          {remaining} open · {state.items.length} total
        </span>
      </div>

      <ul className="desk-todo-list" aria-label={state.title || 'Todo list'}>
        {state.items.length === 0 && (
          <li className="desk-todo-empty meta">No items yet — add one below.</li>
        )}
        {state.items.map((item) => (
          <li key={item.id} className={`desk-todo-item ${item.done ? 'is-done' : ''}`}>
            <input
              id={`${baseId}-${item.id}`}
              type="checkbox"
              checked={item.done}
              onChange={() =>
                update((prev) => ({
                  ...prev,
                  items: prev.items.map((it) =>
                    it.id === item.id ? { ...it, done: !it.done } : it,
                  ),
                }))
              }
            />
            <input
              className="desk-todo-text"
              value={item.text}
              aria-label="Todo item"
              onChange={(e) => {
                const text = e.target.value
                update((prev) => ({
                  ...prev,
                  items: prev.items.map((it) =>
                    it.id === item.id ? { ...it, text } : it,
                  ),
                }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <button
              type="button"
              className="desk-todo-remove"
              aria-label="Remove item"
              onClick={() =>
                update((prev) => ({
                  ...prev,
                  items: prev.items.filter((it) => it.id !== item.id),
                }))
              }
            >
              <Icon name="cross" />
            </button>
          </li>
        ))}
      </ul>

      <div className="desk-todo-add">
        <label className="visually-hidden" htmlFor={`${baseId}-new`}>
          New todo
        </label>
        <input
          id={`${baseId}-new`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add an item…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addItem()
            }
          }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={addItem}
          disabled={!draft.trim()}
        >
          Add
        </button>
      </div>
    </div>
  )
}
