import { useMemo, useState } from 'react'
import { Icon } from '../Icon'
import { useDeskStorage } from '../../lib/useDeskStorage'

type Habit = {
  id: string
  label: string
}

type HabitState = {
  habits: Habit[]
  /** dayKey -> set of completed habit ids */
  done: Record<string, string[]>
}

type Props = { resourceId: string }

const DEFAULT_HABITS: Habit[] = [
  { id: 'h1', label: 'Deep work block' },
  { id: 'h2', label: 'Capture 1 link' },
  { id: 'h3', label: 'Triage inbox' },
  { id: 'h4', label: 'Walk / stretch' },
]

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function storageKey(id: string) {
  return `known.desk.habits.${id}.v1`
}

function newId() {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function fallbackState(): HabitState {
  return { habits: DEFAULT_HABITS.map((h) => ({ ...h })), done: {} }
}

function normalizeState(stored: unknown): HabitState {
  const p = stored as HabitState
  const habits = Array.isArray(p.habits)
    ? p.habits
        .filter((h) => h && typeof h.id === 'string' && typeof h.label === 'string')
        .map((h) => ({ id: h.id, label: h.label.slice(0, 40) }))
    : DEFAULT_HABITS.map((h) => ({ ...h }))
  return {
    habits: habits.length ? habits : DEFAULT_HABITS.map((h) => ({ ...h })),
    done: p.done && typeof p.done === 'object' ? p.done : {},
  }
}

export function HabitTrackerWidget({ resourceId }: Props) {
  const { value: state, update } = useDeskStorage<HabitState>({
    storageKey: storageKey(resourceId),
    fallback: fallbackState,
    normalize: normalizeState,
  })
  const [draft, setDraft] = useState('')
  const today = dayKey()

  const doneToday = useMemo(() => new Set(state.done[today] ?? []), [state.done, today])

  const toggle = (habitId: string) => {
    update((prev) => {
      const set = new Set(prev.done[today] ?? [])
      if (set.has(habitId)) set.delete(habitId)
      else set.add(habitId)
      return {
        ...prev,
        done: { ...prev.done, [today]: [...set] },
      }
    })
  }

  const add = () => {
    const label = draft.trim()
    if (!label) return
    update((prev) => ({
      ...prev,
      habits: [...prev.habits, { id: newId(), label: label.slice(0, 40) }],
    }))
    setDraft('')
  }

  const progress = state.habits.length
    ? Math.round((doneToday.size / state.habits.length) * 100)
    : 0

  return (
    <div className="desk-widget desk-habits" data-resource={resourceId}>
      <div className="desk-habits-head">
        <div>
          <span className="desk-widget-title">Today’s habits</span>
          <p className="meta">
            {doneToday.size}/{state.habits.length} · {progress}%
          </p>
        </div>
        <div className="desk-habits-bar" aria-hidden>
          <span style={{ ['--progress' as string]: String(progress / 100) }} />
        </div>
      </div>

      <ul className="desk-habits-list">
        {state.habits.map((h) => {
          const on = doneToday.has(h.id)
          return (
            <li key={h.id}>
              <button
                type="button"
                className={`desk-habit-row ${on ? 'is-done' : ''}`}
                aria-pressed={on}
                onClick={() => toggle(h.id)}
              >
                <span className="desk-habit-check" aria-hidden>
                  {on ? <Icon name="check" /> : null}
                </span>
                <span className="desk-habit-label">{h.label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <form
        className="desk-habits-add"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a habit…"
          aria-label="New habit"
          maxLength={40}
        />
        <button type="submit" className="btn btn-ghost btn-sm" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  )
}
