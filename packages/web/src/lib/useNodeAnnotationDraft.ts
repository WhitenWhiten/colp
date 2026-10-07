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

  /* Seed from what the server returned (the workflow loads on open); the
     seeds follow the annotation identity, never the local draft. Closing
     clears both seed marks — a retained mark would let a discarded draft
     survive into the next session on the same subject and read as dirty. */
  const tldrSeedRef = useRef<string | null>(null)
  const tldrSeedKey = annotation.tldr ? `${annotation.tldr.id}:${annotation.tldr.revision}` : 'none'
  useEffect(() => {
    if (!open) {
      tldrSeedRef.current = null
      return
    }
    if (tldrSeedRef.current === tldrSeedKey) return
    tldrSeedRef.current = tldrSeedKey
    setTldrDraft(annotation.tldr ? annotationText(annotation.tldr.value) : '')
    setTldrVisibilityState(segmentOf(annotation.tldr?.visibility))
    setTldrVisibilityTouched(false)
  }, [annotation.tldr, open, tldrSeedKey])

  const noteSeedRef = useRef<string | null>(null)
  const noteSeedKey = annotation.note ? `${annotation.note.id}:${annotation.note.revision}` : 'none'
  useEffect(() => {
    if (!open) {
      noteSeedRef.current = null
      return
    }
    if (noteSeedRef.current === noteSeedKey) return
    noteSeedRef.current = noteSeedKey
    setNoteVisibilityState(segmentOf(annotation.note?.visibility))
    setNoteVisibilityTouched(false)
  }, [annotation.note, open, noteSeedKey])

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
