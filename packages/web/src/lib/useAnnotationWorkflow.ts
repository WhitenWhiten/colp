import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  isProductApiError,
  productClient,
  type AnnotationView,
  type AnnotationVisibility,
  type DeleteAnnotationResult,
} from '../api'
import { useConfirm, useConfirmLeaveGuard } from '../components/ConfirmModal'
import { invalidateBookmarkAnnotations } from './useBookmarkAnnotations'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'

export type AnnotationSubjectLocator = {
  collectionId: string
  resourceType: 'collection' | 'node'
  resourceId: string
}

export type AnnotationSaveState =
  | 'loading'
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'unknown'
  | 'stale'
  | 'conflict'
  | 'error'

type MutationKind =
  | 'create-note'
  | 'update-note'
  | 'delete-note'
  | 'create-tldr'
  | 'update-tldr'
  | 'delete-tldr'
  | 'create-highlight'
  | 'delete-highlight'

type PendingMutation = {
  kind: MutationKind
  intentId: string
  annotationId?: string
  ifMatch?: string
  value?: string
  format?: 'plain' | 'markdown'
  /** Create/update visibility; omitted keeps the existing server visibility. */
  visibility?: AnnotationVisibility
}

function annotationText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function highlightQuote(value: unknown): string {
  if (value && typeof value === 'object' && 'quote' in value) {
    const quote = (value as { quote?: unknown }).quote
    if (typeof quote === 'string') return quote
  }
  return annotationText(value)
}

function entityTag(annotation: AnnotationView): string {
  return `"${annotation.revision}"`
}

/**
 * The subject's editable note: the private one when it exists (historical
 * behaviour), otherwise any note — a note whose visibility was switched to
 * Public must stay editable instead of reading as absent and duplicating.
 */
function subjectNote(items: readonly AnnotationView[], visibility?: AnnotationVisibility): AnnotationView | null {
  const notes = items.filter((item) => item.type === 'note' && (visibility === undefined || item.visibility === visibility))
  return notes.find((item) => item.visibility === 'private') ?? notes[0] ?? null
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Build a fresh TL;DR deletion mutation. Retained-intent reuse and the
 * destructive confirm live in the workflow's `removeTldr` — this stays a
 * pure builder. TL;DRs are canonical public-curation content, so the
 * confirmation says so.
 */
function tldrDeleteMutation(
  locator: AnnotationSubjectLocator,
  tldr: AnnotationView,
): PendingMutation {
  return {
    kind: 'delete-tldr', intentId: intentId(locator, 'delete-tldr'),
    annotationId: tldr.id, ifMatch: entityTag(tldr),
  }
}

function intentId(locator: AnnotationSubjectLocator, kind: MutationKind): string {
  return productClient.mutationIntentKey(
    `annotation:${kind}:${locator.collectionId}:${locator.resourceType}:${locator.resourceId}`,
    productClient.newCommandId(),
  )
}

export function useAnnotationWorkflow(locator: AnnotationSubjectLocator | null, noteVisibility?: AnnotationVisibility) {
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [annotations, setAnnotations] = useState<AnnotationView[]>([])
  const [note, setNote] = useState<AnnotationView | null>(null)
  /* TL;DR annotations stay out of the combined editable list, but they are
     fully editable through saveTldr/deleteTldr (FE-06). */
  const [tldr, setTldr] = useState<AnnotationView | null>(null)
  const [draft, setDraftState] = useState('')
  const [baseline, setBaseline] = useState('')
  const [state, setState] = useState<AnnotationSaveState>('loading')
  const [message, setMessage] = useState('Loading annotations')
  const [pending, setPending] = useState<PendingMutation | null>(null)
  const pendingRef = useRef<PendingMutation | null>(null)
  const confirm = useConfirm()
  const generation = useRef(0)
  const controllers = useRef(new Set<AbortController>())
  const noteInputRef = useRef<HTMLTextAreaElement>(null)
  const restoreNoteFocus = useRef(false)

  const setPendingMutation = useCallback((value: PendingMutation | null) => {
    pendingRef.current = value
    setPending(value)
  }, [])

  const abortOutstanding = useCallback(() => {
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
  }, [])

  const controllerForCurrentGeneration = useCallback(() => {
    const controller = new AbortController()
    controllers.current.add(controller)
    return controller
  }, [])

  const replaceFromServer = useCallback((items: AnnotationView[]) => {
    const supported = items.filter((item) => item.type === 'note' || item.type === 'highlight')
    const currentNote = subjectNote(items, noteVisibility)
    const text = currentNote ? annotationText(currentNote.value) : ''
    setTldr(items.find((item) => item.type === 'tldr') ?? null)
    setAnnotations(supported)
    setNote(currentNote)
    setDraftState(text)
    setBaseline(text)
    setPendingMutation(null)
    setState('saved')
    setMessage(currentNote || supported.length > 0 ? 'Saved' : 'No annotations yet')
  }, [noteVisibility, setPendingMutation])

  const load = useCallback(async () => {
    if (!locator) return
    const requestIdentity = sessionIdentity
    const requestGeneration = generation.current
    const controller = controllerForCurrentGeneration()
    setState('loading')
    setMessage('Loading annotations')
    try {
      const items = await productClient.loadAnnotations(
        locator.collectionId,
        { resourceType: locator.resourceType, resourceId: locator.resourceId },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (requestGeneration !== generation.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return
      replaceFromServer(items)
    } catch (error) {
      if (isAbort(error) || requestGeneration !== generation.current
        || privateSessionIdentity() !== requestIdentity) return
      setState('error')
      setMessage(isProductApiError(error) && error.isAuthRequired
        ? 'Sign in to load annotations.'
        : "Couldn't load notes. Try again when the connection is available.")
    } finally {
      controllers.current.delete(controller)
    }
  }, [controllerForCurrentGeneration, locator, replaceFromServer, sessionIdentity])

  useEffect(() => {
    generation.current += 1
    abortOutstanding()
    setAnnotations([])
    setNote(null)
    setTldr(null)
    setDraftState('')
    setBaseline('')
    setPendingMutation(null)
    if (locator) void load()
    return abortOutstanding
    // Primitive locator fields; object identity would reload on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [abortOutstanding, load, locator?.collectionId, locator?.resourceId, locator?.resourceType, setPendingMutation, sessionIdentity])

  const setDraft = useCallback((value: string) => {
    setDraftState(value)
    setState(value === baseline ? 'saved' : 'dirty')
    setMessage(value === baseline ? 'Saved' : 'Unsaved changes')
  }, [baseline])

  const refreshItem = useCallback(async (annotationId: string): Promise<AnnotationView | null> => {
    if (!locator) return null
    const requestIdentity = sessionIdentity
    const requestGeneration = generation.current
    const controller = controllerForCurrentGeneration()
    try {
      const current = await productClient.getAnnotation(locator.collectionId, annotationId, {
        signal: controller.signal,
        maxRetries: 0,
      })
      return requestGeneration === generation.current && !controller.signal.aborted
        && privateSessionIdentity() === requestIdentity ? current : null
    } finally {
      controllers.current.delete(controller)
    }
  }, [controllerForCurrentGeneration, locator, sessionIdentity])

  const refreshAfterConflict = useCallback(async (mutation: PendingMutation): Promise<void> => {
    if (!locator) return
    if (mutation.annotationId) {
      const current = await refreshItem(mutation.annotationId)
      if (current) {
        setAnnotations((items) => items.map((item) => item.id === current.id ? current : item))
        if (current.type === 'note') setNote(subjectNote([current], noteVisibility))
        if (current.type === 'tldr') setTldr(current)
      }
      return
    }
    const requestGeneration = generation.current
    const controller = controllerForCurrentGeneration()
    try {
      const items = await productClient.loadAnnotations(locator.collectionId, {
        resourceType: locator.resourceType,
        resourceId: locator.resourceId,
      }, { signal: controller.signal, maxRetries: 0 })
      if (requestGeneration !== generation.current || controller.signal.aborted) return
      setAnnotations(items.filter((item) => item.type === 'note' || item.type === 'highlight'))
      setNote(subjectNote(items, noteVisibility))
      setTldr(items.find((item) => item.type === 'tldr') ?? null)
    } finally {
      controllers.current.delete(controller)
    }
  }, [controllerForCurrentGeneration, locator, noteVisibility, refreshItem])

  const complete = useCallback((mutation: PendingMutation, result: AnnotationView | DeleteAnnotationResult) => {
    productClient.abandonAnnotationIntent(mutation.intentId)
    setPendingMutation(null)
    if ('receipt' in result) {
      setAnnotations((items) => items.filter((item) => item.id !== mutation.annotationId))
      if (mutation.kind === 'delete-note') {
        setNote(null)
        setDraftState('')
        setBaseline('')
        restoreNoteFocus.current = true
      }
      if (mutation.kind === 'delete-tldr') setTldr(null)
    } else {
      setAnnotations((items) => {
        const without = items.filter((item) => item.id !== result.id)
        return [result, ...without]
      })
      if (result.type === 'note') {
        const text = annotationText(result.value)
        setNote(subjectNote([result], noteVisibility))
        setDraftState(text)
        setBaseline(text)
      }
      if (result.type === 'tldr') setTldr(result)
    }
    setState('saved')
    setMessage('Saved')
  }, [noteVisibility, setPendingMutation])

  useEffect(() => {
    if (!restoreNoteFocus.current || note !== null) return
    restoreNoteFocus.current = false
    noteInputRef.current?.focus()
  }, [note])

  const fail = useCallback(async (mutation: PendingMutation, error: unknown) => {
    if (isAbort(error)) return
    const failureGeneration = generation.current
    if (isProductApiError(error) && error.status === 412 && mutation.annotationId) {
      productClient.abandonAnnotationIntent(mutation.intentId)
      let current: AnnotationView | null
      try {
        current = await refreshItem(mutation.annotationId)
      } catch (refreshError) {
        if (failureGeneration !== generation.current || isAbort(refreshError)) return
        setPendingMutation(null)
        setState('error')
        setMessage("The server version changed, but its current note couldn't be loaded.")
        return
      }
      if (failureGeneration !== generation.current) return
      if (current) {
        setAnnotations((items) => items.map((item) => item.id === current.id ? current : item))
        if (current.type === 'note') setNote(subjectNote([current], noteVisibility))
        if (current.type === 'tldr') setTldr(current)
      }
      setPendingMutation(mutation)
      setState('stale')
      setMessage(mutation.kind.startsWith('delete')
        ? 'The server version changed. Review the refreshed note before deleting its current version.'
        : 'The server version changed. Review your draft before saving it against the refreshed version.')
      return
    }
    if (isProductApiError(error) && (error.isCommandIdReused || error.isCommandResultExpired)) {
      try { await refreshAfterConflict(mutation) } catch { /* keep the retained draft and explicit recovery */ }
      if (failureGeneration !== generation.current) return
      setState('conflict')
      setMessage('This action could not be completed. Review the retained draft and save again.')
      return
    }
    if (isProductApiError(error) && (error.sameRequestRetrySafe || error.recovery === 'same_request')) {
      setState('unknown')
      setMessage(mutation.kind.startsWith('delete')
        ? 'The delete may not have completed. Try again to confirm the result.'
        : 'The save may not have completed. Try again to confirm the result.')
      return
    }
    productClient.abandonAnnotationIntent(mutation.intentId)
    setPendingMutation(null)
    setState('error')
    setMessage(isProductApiError(error) ? error.recoveryHint : 'The Annotation request failed.')
  }, [noteVisibility, refreshAfterConflict, refreshItem, setPendingMutation])

  /**
   * Runs one mutation. Resolves true when the server accepted it (or the
   * replay resolved a retained intent) and false when the outcome is still
   * unresolved (stale/conflict/unknown/error) — callers that merge the
   * Annotation save with another write use this instead of assuming success.
   */
  const execute = useCallback(async (mutation: PendingMutation): Promise<boolean> => {
    if (!locator) return false
    const requestIdentity = sessionIdentity
    const requestGeneration = generation.current
    const controller = controllerForCurrentGeneration()
    setPendingMutation(mutation)
    setState('saving')
    setMessage(mutation.kind.startsWith('delete') ? 'Deleting' : 'Saving')
    try {
      let result: AnnotationView | DeleteAnnotationResult
      if (mutation.kind === 'create-note' || mutation.kind === 'create-tldr'
        || mutation.kind === 'create-highlight') {
        const highlight = mutation.kind === 'create-highlight'
        const tldrCreate = mutation.kind === 'create-tldr'
        result = await productClient.createAnnotation(locator.collectionId, {
          resourceType: locator.resourceType,
          resourceId: locator.resourceId,
        }, {
          type: highlight ? 'highlight' : tldrCreate ? 'tldr' : 'note',
          format: highlight ? 'json' : (mutation.format ?? (tldrCreate ? 'plain' : 'markdown')),
          value: highlight ? { quote: mutation.value ?? '' } : mutation.value ?? '',
          visibility: mutation.visibility ?? 'private',
        }, {
          intentId: mutation.intentId, signal: controller.signal,
          maxRetries: 0, clearIntentOnSuccess: false,
        })
      } else if (mutation.kind === 'update-note' || mutation.kind === 'update-tldr') {
        const existing = mutation.kind === 'update-tldr' ? tldr : note
        result = await productClient.updateAnnotation(
          locator.collectionId, mutation.annotationId!,
          {
            value: mutation.value ?? '',
            format: mutation.format ?? (existing?.format === 'markdown' ? 'markdown' : 'plain'),
            ...(mutation.visibility !== undefined ? { visibility: mutation.visibility } : {}),
          }, mutation.ifMatch!,
          { intentId: mutation.intentId, signal: controller.signal, maxRetries: 0, clearIntentOnSuccess: false },
        )
      } else {
        result = await productClient.deleteAnnotation(
          locator.collectionId, mutation.annotationId!, mutation.ifMatch!,
          { intentId: mutation.intentId, signal: controller.signal, maxRetries: 0, clearIntentOnSuccess: false },
        )
      }
      if (requestGeneration !== generation.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return false
      complete(mutation, result)
      // The library desk caches note/TL;DR snippets per subject; a saved or
      // deleted annotation must not leave a stale card behind.
      invalidateBookmarkAnnotations(locator.collectionId, locator.resourceId)
      return true
    } catch (error) {
      if (requestGeneration !== generation.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return false
      await fail(mutation, error)
      return false
    } finally {
      controllers.current.delete(controller)
    }
  }, [complete, controllerForCurrentGeneration, fail, locator, note, setPendingMutation, tldr, sessionIdentity])

  const saveNote = useCallback(async (forceNew = false, visibility?: AnnotationVisibility): Promise<boolean> => {
    if (!locator) return false
    const existing = pendingRef.current
    if (!forceNew && existing && (state === 'unknown')) {
      return execute(existing)
    }
    if (forceNew && existing) productClient.abandonAnnotationIntent(existing.intentId)
    const mutation: PendingMutation = note
      ? { kind: 'update-note', intentId: intentId(locator, 'update-note'), annotationId: note.id,
          ifMatch: entityTag(note), value: draft, format: note.format === 'markdown' ? 'markdown' : 'plain',
          ...(visibility !== undefined ? { visibility } : {}) }
      : { kind: 'create-note', intentId: intentId(locator, 'create-note'), value: draft, format: 'markdown',
          ...(visibility !== undefined ? { visibility } : {}) }
    return execute(mutation)
  }, [draft, execute, locator, note, state])

  const deleteNote = useCallback((forceNew = false) => {
    if (!locator || !note) return
    const existing = pendingRef.current
    if (!forceNew && existing?.kind === 'delete-note' && state === 'unknown') {
      void execute(existing)
      return
    }
    if (forceNew && existing) productClient.abandonAnnotationIntent(existing.intentId)
    const run = () => void execute({
      kind: 'delete-note', intentId: intentId(locator, 'delete-note'),
      annotationId: note.id, ifMatch: entityTag(note),
    })
    if (forceNew) {
      run()
      return
    }
    // R9-19: shared destructive confirm (Modal tone="danger") replaces the
    // native window.confirm; the delete only runs after it resolves true.
    void confirm({ title: 'Delete this private note?', body: "This can't be undone.", confirmLabel: 'Delete note' })
      .then((ok) => { if (ok) run() })
  }, [confirm, execute, locator, note, state])

  /**
   * Resolve the TL;DR deletion mutation for saveTldr('')/deleteTldr: reuses
   * the retained intent when a delete's outcome is still unknown (the
   * operator already confirmed that one) and runs the shared destructive
   * confirm before minting a new delete intent. Null = cancelled/absent.
   */
  const removeTldr = useCallback(async (forceNew = false): Promise<PendingMutation | null> => {
    if (!locator || !tldr) return null
    const existing = pendingRef.current
    if (!forceNew && existing?.kind === 'delete-tldr' && state === 'unknown') return existing
    if (forceNew && existing) productClient.abandonAnnotationIntent(existing.intentId)
    if (!forceNew && !(await confirm({ title: 'Delete this TL;DR?', body: "This can't be undone.", confirmLabel: 'Delete TL;DR' }))) {
      return null
    }
    return tldrDeleteMutation(locator, tldr)
  }, [confirm, locator, state, tldr])

  /**
   * Create/update the subject's TL;DR through the same intent-idempotent
   * state machine as the note. `text` is explicit because the drawer owns the
   * TL;DR draft; a blank text deletes the existing annotation.
   */
  const saveTldr = useCallback(async (
    text: string,
    visibility?: AnnotationVisibility,
    forceNew = false,
  ): Promise<boolean> => {
    if (!locator) return false
    const existing = pendingRef.current
    if (!forceNew && existing && state === 'unknown'
      && (existing.kind === 'create-tldr' || existing.kind === 'update-tldr')) {
      return execute(existing)
    }
    if (forceNew && existing) productClient.abandonAnnotationIntent(existing.intentId)
    if (!text.trim()) {
      // Clearing the field removes the annotation; nothing to do when absent.
      if (!tldr) return true
      const removal = await removeTldr(forceNew)
      return removal ? execute(removal) : false
    }
    const mutation: PendingMutation = tldr
      ? { kind: 'update-tldr', intentId: intentId(locator, 'update-tldr'), annotationId: tldr.id,
          ifMatch: entityTag(tldr), value: text, format: tldr.format === 'markdown' ? 'markdown' : 'plain',
          ...(visibility !== undefined ? { visibility } : {}) }
      : { kind: 'create-tldr', intentId: intentId(locator, 'create-tldr'), value: text, format: 'plain',
          ...(visibility !== undefined ? { visibility } : {}) }
    return execute(mutation)
  }, [execute, locator, removeTldr, state, tldr])

  const deleteTldr = useCallback((forceNew = false) => {
    void removeTldr(forceNew).then((mutation) => {
      if (mutation) void execute(mutation)
    })
  }, [execute, removeTldr])

  const toggleHighlight = useCallback((value: string) => {
    if (!locator || draft !== baseline || state === 'saving' || state === 'unknown') return
    const existing = annotations.find((item) => item.type === 'highlight' && highlightQuote(item.value) === value)
    void execute(existing
      ? { kind: 'delete-highlight', intentId: intentId(locator, 'delete-highlight'),
          annotationId: existing.id, ifMatch: entityTag(existing), value }
      : { kind: 'create-highlight', intentId: intentId(locator, 'create-highlight'), value })
  }, [annotations, baseline, draft, execute, locator, state])

  const startNewSave = useCallback(() => saveNote(true), [saveNote])
  const retry = useCallback(() => {
    const existing = pendingRef.current
    if (existing) void execute(existing)
  }, [execute])

  const startNewPending = useCallback(() => {
    const existing = pendingRef.current
    if (!existing || !locator) return
    if (existing.kind === 'create-note' || existing.kind === 'update-note') {
      saveNote(true)
      return
    }
    if (existing.kind === 'delete-note') {
      deleteNote(true)
      return
    }
    if (existing.kind === 'create-tldr' || existing.kind === 'update-tldr' || existing.kind === 'delete-tldr') {
      productClient.abandonAnnotationIntent(existing.intentId)
      const next = existing.kind === 'delete-tldr'
        ? (tldr
            ? { kind: 'delete-tldr' as const, intentId: intentId(locator, 'delete-tldr'),
                annotationId: tldr.id, ifMatch: entityTag(tldr) }
            : null)
        : (tldr
            ? { kind: 'update-tldr' as const, intentId: intentId(locator, 'update-tldr'), annotationId: tldr.id,
                ifMatch: entityTag(tldr), value: existing.value ?? '', format: existing.format,
                ...(existing.visibility !== undefined ? { visibility: existing.visibility } : {}) }
            : { kind: 'create-tldr' as const, intentId: intentId(locator, 'create-tldr'),
                value: existing.value ?? '', format: 'plain' as const,
                ...(existing.visibility !== undefined ? { visibility: existing.visibility } : {}) })
      if (!next) {
        setPendingMutation(null)
        setState('saved')
        setMessage('Saved')
        return
      }
      void execute(next)
      return
    }
    productClient.abandonAnnotationIntent(existing.intentId)
    const current = annotations.find((item) => item.type === 'highlight'
      && highlightQuote(item.value) === existing.value)
    if ((existing.kind === 'create-highlight' && current)
        || (existing.kind === 'delete-highlight' && !current)) {
      setPendingMutation(null)
      setState('saved')
      setMessage('Saved')
      return
    }
    const next = existing.kind === 'create-highlight'
      ? { kind: 'create-highlight' as const, intentId: intentId(locator, 'create-highlight'), value: existing.value }
      : { kind: 'delete-highlight' as const, intentId: intentId(locator, 'delete-highlight'),
          annotationId: current!.id, ifMatch: entityTag(current!), value: existing.value }
    void execute(next)
  }, [annotations, deleteNote, execute, locator, saveNote, setPendingMutation, tldr])

  const highlighted = useMemo(() => new Set(
    annotations.filter((item) => item.type === 'highlight').map((item) => highlightQuote(item.value)),
  ), [annotations])
  const dirty = draft !== baseline || ['saving', 'unknown', 'stale', 'conflict'].includes(state)

  // R9-19: the shared async confirm guards in-app navigation; beforeunload
  // stays browser-native inside the hook.
  useConfirmLeaveGuard(dirty, {
    title: 'Discard changes?',
    body: 'You have unsaved changes on this page.',
    confirmLabel: 'Discard',
  })

  return {
    annotations,
    note,
    tldr,
    draft,
    state,
    message,
    pending,
    highlighted,
    dirty,
    noteInputRef,
    setDraft,
    saveNote,
    deleteNote,
    saveTldr,
    deleteTldr,
    toggleHighlight,
    retry,
    startNewSave,
    startNewPending,
    reload: load,
  }
}
