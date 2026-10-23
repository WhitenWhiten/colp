import { useCallback, useEffect, useRef, useState } from 'react'
import type { SegmentVisibility } from '../components/NodeAnnotationFields'
import type { useAnnotationWorkflow } from './useAnnotationWorkflow'

function annotationText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function segmentOf(visibility: string | null | undefined): SegmentVisibility {
  return visibility === 'public' ? 'public' : 'private'
}

type AnnotationWorkflow = ReturnType<typeof useAnnotationWorkflow>

/**
 * The note/TL;DR half of an editable node, shared by the library desk drawer
 * (FE-04) and the collection editor (FE-07).
 *
 * The note text lives in the workflow itself (its own draft + dirty guard);
 * this hook owns the TL;DR text and both Private/Public switches. A switch is
 * only sent when the user actually moved it, so an untouched switch never
 * rewrites a visibility the two-segment control cannot express.
 */
export function useNodeAnnotationDraft(annotation: AnnotationWorkflow, open: boolean) {
  const [tldrDraft, setTldrDraft] = useState('')
  const [tldrVisibility, setTldrVisibilityState] = useState<SegmentVisibility>('private')
  const [noteVisibility, setNoteVisibilityState] = useState<SegmentVisibility>('private')
  const [tldrVisibilityTouched, setTldrVisibilityTouched] = useState(false)
  const [noteVisibilityTouched, setNoteVisibilityTouched] = useState(false)

  const tldrValue = annotation.tldr ? annotationText(annotation.tldr.value) : ''
  const tldrDirty = tldrDraft.trim() !== tldrValue.trim() || tldrVisibilityTouched
  const noteDirty = annotation.dirty || noteVisibilityTouched
  const dirty = tldrDirty || noteDirty

  // A server revision updates the baseline; it must not replace dirty input.
  // Closing or changing annotation identity starts a fresh editing session.
  const tldrSeedRef = useRef<{ key: string; id: string | null; text: string } | null>(null)
  const tldrSeedKey = annotation.tldr ? `${annotation.tldr.id}:${annotation.tldr.revision}` : 'none'
  useEffect(() => {
    if (!open) {
      tldrSeedRef.current = null
      return
    }
    const previous = tldrSeedRef.current
    if (previous?.key === tldrSeedKey) return
    const id = annotation.tldr?.id ?? null
    const text = annotation.tldr ? annotationText(annotation.tldr.value) : ''
    tldrSeedRef.current = { key: tldrSeedKey, id, text }
    if (previous?.id === id && (tldrDraft.trim() !== previous.text.trim() || tldrVisibilityTouched)) return
    setTldrDraft(text)
    setTldrVisibilityState(segmentOf(annotation.tldr?.visibility))
    setTldrVisibilityTouched(false)
  }, [annotation.tldr, open, tldrSeedKey, tldrDraft, tldrVisibilityTouched])

  const noteSeedRef = useRef<{ key: string; id: string | null } | null>(null)
  const noteSeedKey = annotation.note ? `${annotation.note.id}:${annotation.note.revision}` : 'none'
  useEffect(() => {
    if (!open) {
      noteSeedRef.current = null
      return
    }
    const previous = noteSeedRef.current
    if (previous?.key === noteSeedKey) return
    const id = annotation.note?.id ?? null
    noteSeedRef.current = { key: noteSeedKey, id }
    if (previous?.id === id && noteVisibilityTouched) return
    setNoteVisibilityState(segmentOf(annotation.note?.visibility))
    setNoteVisibilityTouched(false)
  }, [annotation.note, open, noteSeedKey, noteVisibilityTouched])

  const setTldrVisibility = useCallback((value: SegmentVisibility) => {
    setTldrVisibilityState(value)
    setTldrVisibilityTouched(true)
  }, [])

  const setNoteVisibility = useCallback((value: SegmentVisibility) => {
    setNoteVisibilityState(value)
    setNoteVisibilityTouched(true)
  }, [])

  /**
   * Persist whichever half changed. Resolves true when every requested write
   * landed (or there was nothing to do); the workflow keeps its own
   * unknown/stale/conflict recovery, so a false here means the caller must not
   * report a clean save.
   */
  const save = useCallback(async (): Promise<boolean> => {
    let ok = true
    if (tldrDirty) {
      ok = (await annotation.saveTldr(
        tldrDraft,
        tldrVisibilityTouched ? tldrVisibility : undefined,
      )) && ok
    }
    if (noteDirty) {
      ok = (await annotation.saveNote(false, noteVisibilityTouched ? noteVisibility : undefined)) && ok
    }
    if (ok) {
      setTldrVisibilityTouched(false)
      setNoteVisibilityTouched(false)
    }
    return ok
  }, [
    annotation, noteDirty, noteVisibility, noteVisibilityTouched, tldrDirty, tldrDraft,
    tldrVisibility, tldrVisibilityTouched,
  ])

  return {
    tldrDraft,
    setTldrDraft,
    tldrVisibility,
    setTldrVisibility,
    noteVisibility,
    setNoteVisibility,
    tldrDirty,
    noteDirty,
    dirty,
    save,
  }
}
