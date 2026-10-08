import { useCallback, useEffect, useState } from 'react'

type Props = {
  resourceId: string
}

function storageKey(id: string) {
  return `known.desk.sticky.${id}.v1`
}

function loadNote(id: string): string {
  try {
    return localStorage.getItem(storageKey(id)) ?? ''
  } catch {
    return ''
  }
}

export function StickyNote({ resourceId }: Props) {
  const [text, setText] = useState(() => loadNote(resourceId))
  const [saved, setSaved] = useState(true)

  useEffect(() => {
    setText(loadNote(resourceId))
    setSaved(true)
  }, [resourceId])

  const persist = useCallback(
    (value: string) => {
      try {
        localStorage.setItem(storageKey(resourceId), value)
      } catch {
        /* ignore */
      }
      setSaved(true)
    },
    [resourceId],
  )

  useEffect(() => {
    if (saved) return
    const id = window.setTimeout(() => persist(text), 320)
    return () => window.clearTimeout(id)
  }, [text, saved, persist])

  return (
    <div className="desk-widget">
      <div className="desk-widget-head">
        <span className="desk-sticky-hint">Local note · autosave</span>
        <span className={`desk-sticky-status ${saved ? 'is-saved' : ''}`} aria-live="polite">
          {saved ? 'Saved' : 'Saving…'}
        </span>
      </div>
      <label className="visually-hidden" htmlFor={`sticky-${resourceId}`}>
        Sticky note
      </label>
      <textarea
        id={`sticky-${resourceId}`}
        className="desk-sticky-body"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setSaved(false)
        }}
        placeholder="Ideas, link drafts, reminders…"
        spellCheck
      />
    </div>
  )
}
