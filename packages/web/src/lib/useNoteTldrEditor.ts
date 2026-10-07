import { useCallback, useRef, useState } from 'react'

export type NoteTldrSource = 'ai' | 'user' | 'empty'
export type NoteTldrFormat = 'plain' | 'markdown'

export type NoteTldrMeta = {
  note: string
  tldr: string
  tldrSource: NoteTldrSource
  noteFormat?: NoteTldrFormat
  tldrFormat?: NoteTldrFormat
}

type UseNoteTldrEditorOptions = {
  /** Meta seeding the drafts; later external changes flow through syncMeta/resetMeta. */
  initial: NoteTldrMeta
  /** Persist a patch; returns the canonical stored meta. */
  persist: (patch: Partial<NoteTldrMeta>) => NoteTldrMeta
  /** Produce an AI TL;DR draft. */
  generate: () => Promise<string>
  /** Toast channel; tone 'success' for explicit note saves, 'plain' otherwise. */
  notify: (message: string, tone: 'plain' | 'success') => void
}

/**
 * Note + TL;DR draft state machine shared by the collection-list popover
 * editor and the demo library's note panel: local drafts with dirty flags,
 * blur-save, AI generate. Owns no syncing policy — callers decide when to
 * adopt external meta (syncMeta keeps unsaved drafts, resetMeta discards).
 * All returned handlers are stable (safe as effect deps); drafts read fresh
 * through a latest-ref mirror.
 */
export function useNoteTldrEditor({ initial, persist, generate, notify }: UseNoteTldrEditorOptions) {
  const baselineRef = useRef({ note: initial.note, tldr: initial.tldr, noteFormat: initial.noteFormat, tldrFormat: initial.tldrFormat })
  const [note, setNoteDraft] = useState(initial.note)
  const [tldr, setTldrDraft] = useState(initial.tldr)
  const [tldrSource, setTldrSource] = useState<NoteTldrSource>(initial.tldrSource)
  const [noteFormat, setNoteFormat] = useState<NoteTldrFormat>(initial.noteFormat ?? 'plain')
  const [tldrFormat, setTldrFormat] = useState<NoteTldrFormat>(initial.tldrFormat ?? 'plain')
  const [noteDirty, setNoteDirty] = useState(false)
  const [tldrDirty, setTldrDirty] = useState(false)
  const [generating, setGenerating] = useState(false)
  // In-flight guard must flip synchronously — a same-tick double click would
  // otherwise pass a render-closure check twice.
  const generatingRef = useRef(false)

  const stateRef = useRef({ note, tldr, noteDirty, tldrDirty })
  stateRef.current = { note, tldr, noteDirty, tldrDirty }
  const persistRef = useRef(persist)
  persistRef.current = persist
  const generateRef = useRef(generate)
  generateRef.current = generate
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  /** Textarea setter — typing marks the note dirty. */
  const setNote = useCallback((value: string) => {
    setNoteDraft(value)
    setNoteDirty(true)
  }, [])

  /** Textarea setter — typing marks the TL;DR dirty and user-authored. */
  const setTldr = useCallback((value: string) => {
    setTldrDraft(value)
    setTldrSource(value.trim() ? 'user' : 'empty')
    setTldrDirty(true)
  }, [])

  /** Adopt external meta without clobbering unsaved drafts. */
  const syncMeta = useCallback((meta: NoteTldrMeta) => {
    if (!stateRef.current.noteDirty) {
      setNoteDraft(meta.note)
      setNoteFormat(meta.noteFormat ?? 'plain')
      baselineRef.current.note = meta.note
      baselineRef.current.noteFormat = meta.noteFormat
    }
    if (!stateRef.current.tldrDirty) {
      setTldrDraft(meta.tldr)
      setTldrSource(meta.tldrSource)
      setTldrFormat(meta.tldrFormat ?? 'plain')
      baselineRef.current.tldr = meta.tldr
      baselineRef.current.tldrFormat = meta.tldrFormat
    }
  }, [])

  /** Item switched: adopt meta wholesale and clear dirty flags. */
  const resetMeta = useCallback((meta: NoteTldrMeta) => {
    baselineRef.current = { note: meta.note, tldr: meta.tldr, noteFormat: meta.noteFormat, tldrFormat: meta.tldrFormat }
    setNoteDraft(meta.note)
    setTldrDraft(meta.tldr)
    setTldrSource(meta.tldrSource)
    setNoteFormat(meta.noteFormat ?? 'plain')
    setTldrFormat(meta.tldrFormat ?? 'plain')
    setNoteDirty(false)
    setTldrDirty(false)
  }, [])

  const saveNote = useCallback(() => {
    const text = stateRef.current.note.trim()
    const patch: Partial<NoteTldrMeta> = { note: text }
    if (baselineRef.current.noteFormat !== undefined) {
      patch.noteFormat = text ? (baselineRef.current.note ? baselineRef.current.noteFormat : 'markdown') : 'plain'
    }
    const next = persistRef.current(patch)
    baselineRef.current.note = next.note
    baselineRef.current.noteFormat = next.noteFormat
    setNoteDraft(next.note)
    setNoteFormat(next.noteFormat ?? 'markdown')
    setNoteDirty(false)
    notifyRef.current(next.note ? 'Note saved' : 'Note cleared', 'success')
  }, [])

  const saveTldr = useCallback((source: NoteTldrSource = 'user') => {
    const text = stateRef.current.tldr.trim()
    const patch: Partial<NoteTldrMeta> = { tldr: text, tldrSource: text ? source : 'empty' }
    if (baselineRef.current.tldrFormat !== undefined) {
      patch.tldrFormat = text ? (baselineRef.current.tldr ? baselineRef.current.tldrFormat : 'markdown') : 'plain'
    }
    const next = persistRef.current(patch)
    baselineRef.current.tldr = next.tldr
    baselineRef.current.tldrFormat = next.tldrFormat
    setTldrDraft(next.tldr)
    setTldrSource(next.tldrSource)
    setTldrFormat(next.tldrFormat ?? (text ? 'markdown' : 'plain'))
    setTldrDirty(false)
    notifyRef.current(
      text ? (source === 'ai' ? 'TL;DR generated' : 'TL;DR saved') : 'TL;DR cleared',
      'plain',
    )
  }, [])

  const generateTldr = useCallback(async () => {
    if (generatingRef.current) return
    generatingRef.current = true
    setGenerating(true)
    try {
      const draft = await generateRef.current()
      setTldrDraft(draft)
      setTldrSource('ai')
      const patch: Partial<NoteTldrMeta> = { tldr: draft, tldrSource: 'ai' }
      if (baselineRef.current.tldrFormat !== undefined) {
        patch.tldrFormat = baselineRef.current.tldr ? baselineRef.current.tldrFormat : 'markdown'
      }
      persistRef.current(patch)
      baselineRef.current.tldr = draft
      baselineRef.current.tldrFormat = patch.tldrFormat
      setTldrFormat((patch.tldrFormat as NoteTldrFormat | undefined) ?? 'markdown')
      setTldrDirty(false)
      notifyRef.current('TL;DR generated · you can edit it', 'plain')
    } finally {
      generatingRef.current = false
      setGenerating(false)
    }
  }, [])

  return {
    note,
    setNote,
    tldr,
    setTldr,
    tldrSource,
    noteFormat,
    tldrFormat,
    noteDirty,
    tldrDirty,
    generating,
    syncMeta,
    resetMeta,
    saveNote,
    saveTldr,
    generateTldr,
  }
}
