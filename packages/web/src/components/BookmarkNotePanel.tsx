import { useEffect } from 'react'
import { useToast } from './AppToast'
import { useNoteTldrEditor, type NoteTldrMeta } from '../lib/useNoteTldrEditor'

/** Persisted private note + TL;DR on a bookmark row (in-page compose). */
export type BookmarkNoteMeta = NoteTldrMeta

type Props = {
  id: string
  meta: BookmarkNoteMeta
  onPersist: (patch: Partial<BookmarkNoteMeta>) => BookmarkNoteMeta
  onGenerate: () => Promise<string>
}

/**
 * Expanded Note / TL;DR editor used by the `/demo/library` stack.
 * The product library desk / Reading do not have this compose surface.
 */
export function BookmarkNotePanel({ id, meta, onPersist, onGenerate }: Props) {
  const { toast } = useToast()
  const {
    note,
    setNote,
    tldr,
    setTldr,
    tldrSource,
    noteDirty,
    tldrDirty,
    generating,
    resetMeta,
    saveNote,
    saveTldr,
    generateTldr,
  } = useNoteTldrEditor({
    initial: meta,
    persist: onPersist,
    generate: onGenerate,
    notify: (message) => toast(message),
  })

  useEffect(() => {
    resetMeta({ note: meta.note, tldr: meta.tldr, tldrSource: meta.tldrSource, noteFormat: meta.noteFormat, tldrFormat: meta.tldrFormat })
  }, [id, meta.note, meta.tldr, meta.tldrSource, meta.noteFormat, meta.tldrFormat, resetMeta])

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: keeps panel clicks from reaching the parent row/card handlers; the interactive children are native inputs/buttons
    <div className="lib-link-panel" onClick={(e) => e.stopPropagation()}>
      <section className="lib-field">
        <div className="lib-field-head">
          <label htmlFor={`note-${id}`}>
            <span className="lib-field-title">Note</span>
            <span className="lib-field-hint">Yours only · private</span>
          </label>
          {noteDirty && (
            <button type="button" className="btn btn-primary btn-sm" onClick={saveNote}>
              Save note
            </button>
          )}
        </div>
        <textarea
          id={`note-${id}`}
          className="lib-textarea"
          rows={3}
          value={note}
          placeholder="Why you saved this, questions, follow-ups…"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (noteDirty) saveNote()
          }}
        />
      </section>

      <section className="lib-field lib-field--tldr">
        <div className="lib-field-head">
          <label htmlFor={`tldr-${id}`}>
            <span className="lib-field-title">TL;DR</span>
            <span className="lib-field-hint">
              {tldrSource === 'ai' && 'AI draft · editable'}
              {tldrSource === 'user' && 'Manually edited'}
              {tldrSource === 'empty' && 'AI generate, or write your own'}
            </span>
          </label>
          <div className="lib-field-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={generating}
              onClick={generateTldr}
            >
              {generating ? 'Generating…' : tldr.trim() ? 'Regenerate' : 'Generate TL;DR'}
            </button>
            {tldrDirty && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => saveTldr('user')}
              >
                Save TL;DR
              </button>
            )}
          </div>
        </div>
        <textarea
          id={`tldr-${id}`}
          className={`lib-textarea lib-textarea--tldr ${tldrSource === 'ai' ? 'is-ai' : ''}`}
          rows={3}
          value={tldr}
          placeholder="Short takeaway — generate with AI or type it yourself…"
          onChange={(e) => setTldr(e.target.value)}
          onBlur={() => {
            if (tldrDirty) saveTldr('user')
          }}
        />
        {generating && (
          <p className="lib-generating meta" aria-live="polite">
            Know-N AI is drafting a TL;DR from the title and host…
          </p>
        )}
      </section>
    </div>
  )
}
