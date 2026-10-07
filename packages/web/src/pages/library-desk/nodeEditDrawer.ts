import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  type AnnotationVisibility,
  type EditableNodeView,
  type EditorSnapshot,
} from '../../api'
import { addTags } from '../../components/TagInput'
import { countTags } from '../../lib/libraryTags'
import { useAnnotationWorkflow } from '../../lib/useAnnotationWorkflow'
import { useNodeAnnotationDraft } from '../../lib/useNodeAnnotationDraft'

/** Same limits the canonical editor and the annotation contract enforce. */
export const NODE_TITLE_MAX = 512
export const NODE_URL_MAX = 4096
export const NODE_DESCRIPTION_MAX = 20000
const BOOKMARK_FAVICON_MAX_BYTES = 65536

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((tag, index) => tag === b[index])

function isDeclaredRejectedFaviconType(type: string): boolean {
  const declared = type.trim().toLowerCase()
  return declared.includes('svg') || declared.includes('gif') || declared.includes('html')
}

export type NodeEditDrawerOptions = {
  snap: EditorSnapshot | null
  /** Kept during the exit beat so the closing frame still paints its node. */
  nodeId: string | null
  open: boolean
  loadTree: (key: string, opts?: { silent?: boolean }) => Promise<void>
  navigate: NavigateFunction
  toast: (message: string) => void
  success: (message: string) => void
  error: (message: string) => void
  refreshSession: () => Promise<void>
}

/**
 * FE-04 drawer state and persistence.
 *
 * One Save button covers both halves of the record: the node fields go through
 * `PATCH /collections/{id}/nodes/{nodeId}` first, then the note/TL;DR through
 * the FE-06 annotation workflow (intent-idempotent, 412-stale, unknown-retry).
 * Favicon upload is immediate, exactly like the collection editor — it is a
 * binary upload, not a field of the merged Save.
 */
export function useNodeEditDrawer({
  snap,
  nodeId,
  open,
  loadTree,
  navigate,
  toast,
  success,
  error,
  refreshSession,
}: NodeEditDrawerOptions) {
  const node = useMemo<EditableNodeView | null>(() => {
    if (!nodeId || !snap) return null
    return snap.nodes.find((candidate) => candidate.id === nodeId) ?? null
  }, [nodeId, snap])

  const collectionId = snap?.collection.id ?? null
  const locator = useMemo(() => (
    node && collectionId
      ? { collectionId, resourceType: 'node' as const, resourceId: node.id }
      : null
  ), [collectionId, node])

  /* The annotation half of the record: the note draft lives in the workflow
     (single source of truth, its own dirty guard); the drawer owns the TL;DR
     text and both visibility switches. */
  const annotation = useAnnotationWorkflow(open ? locator : null)

  /* TL;DR text + both visibility switches; the note draft is the workflow's. */
  const annotations = useNodeAnnotationDraft(annotation, open)

  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  /* The collection's tags, offered while typing so one tag keeps one spelling. */
  const tagVocabulary = useMemo(
    () => countTags((snap?.nodes ?? []).filter((candidate) => candidate.kind === 'bookmark')),
    [snap],
  )
  const [faviconBusy, setFaviconBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const changed = useCallback((next: string, current: string | null | undefined) => (
    next !== (current ?? '')
  ), [])

  const nodeDirty = node !== null && (
    changed(title, node.title)
    || (node.kind === 'bookmark' && changed(url, node.url))
    || changed(description, node.description)
    || !sameTags(tags, node.tags)
    || tagDraft.trim() !== ''
  )

  const dirty = nodeDirty || annotations.dirty

  /* Re-seed the node fields for each session and each subject switch, or
     when a refresh brings a new revision while nothing is being edited.
     Closing clears the seed mark — the exit beat keeps the old node alive,
     so without `open` here a stale draft survives into the next session
     and reads as dirty against a different subject. */
  const seedKey = node ? `${node.id}:${node.revision}` : null
  const seedRef = useRef<string | null>(null)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    if (!open || !node || !seedKey) {
      seedRef.current = null
      return
    }
    if (seedRef.current === seedKey) return
    const sameSubject = seedRef.current?.startsWith(`${node.id}:`) ?? false
    if (sameSubject && dirtyRef.current) return
    seedRef.current = seedKey
    setTitle(node.title)
    setUrl(node.kind === 'bookmark' ? node.url : '')
    setDescription(node.description ?? '')
    setTags([...node.tags])
    setTagDraft('')
    setMessage('')
  }, [node, open, seedKey])

  /** Shared shape of the desk's product-error handling. */
  const handleError = useCallback(async (err: unknown, fallback: string) => {
    if (isProductApiError(err) && err.isAuthRequired) {
      toast('Sign in required')
      navigate(`/login?returnTo=${encodeURIComponent(collectionId ? `/library/${collectionId}` : '/library')}`)
      return
    }
    if (isProductApiError(err) && err.isCsrfFailed) {
      await refreshSession()
      toast('Your session was refreshed. Try again.')
      return
    }
    error(isProductApiError(err) ? err.recoveryHint : fallback)
  }, [collectionId, error, navigate, refreshSession, toast])

  const save = useCallback(async () => {
    if (!snap || !node || saving) return
    if (!snap.capabilities.updateNode || node.readOnly) {
      error(node.readOnlyReason || (node.kind === 'folder' ? 'This folder is read-only' : 'This bookmark is read-only'))
      return
    }
    const nextTitle = title.trim()
    if (!nextTitle) {
      setMessage('Title is required')
      return
    }
    setSaving(true)
    setMessage('Saving…')
    try {
      if (nodeDirty) {
        const intentId = productClient.mutationIntentKey(
          `update-node:${node.id}`,
          productClient.newCommandId(),
        )
        const nextDescription = description.trim() ? description.trim() : null
        // A tag still being typed when Save is pressed is part of the save.
        const nextTags = addTags(tags, [tagDraft], tagVocabulary)
        setTags(nextTags)
        setTagDraft('')
        await productClient.updateCollectionNode(
          snap.collection.id,
          node.id,
          node.kind === 'bookmark'
            ? { title: nextTitle, url: url.trim(), description: nextDescription, tags: nextTags }
            : { title: nextTitle, description: nextDescription, tags: nextTags },
          node.etag,
          { intentId },
        )
      }
      // Annotations run after the node patch: the FE-06 state machine owns its
      // own unknown/stale/conflict recovery, so a rejected save never turns
      // into a silent success here.
      if (!(await annotations.save())) {
        setMessage("Saved the bookmark, but the note or TL;DR didn't save. Try again.")
        return
      }
      await loadTree(snap.collection.id, { silent: true })
      setMessage('Saved')
    } catch (err) {
      await handleError(err, "Couldn't save this item")
    } finally {
      setSaving(false)
    }
  }, [annotations, description, error, handleError, loadTree, node, nodeDirty, saving, snap, tagDraft, tagVocabulary, tags, title, url])

  const uploadFavicon = useCallback(async (file: File | undefined) => {
    if (!snap || !node || node.kind !== 'bookmark' || !file) return
    if (!snap.capabilities.updateNode || node.readOnly) return
    if (file.size > BOOKMARK_FAVICON_MAX_BYTES) {
      error('Icons must be 64 KB or smaller')
      return
    }
    if (isDeclaredRejectedFaviconType(file.type)) {
      error('Favicon cannot be SVG, GIF, or HTML')
      return
    }
    setFaviconBusy(true)
    try {
      const intentId = productClient.mutationIntentKey(
        `upload-favicon:${snap.collection.id}:${node.id}`,
        productClient.newCommandId(),
      )
      await productClient.uploadBookmarkFavicon(snap.collection.id, node.id, file, { intentId })
      await loadTree(snap.collection.id, { silent: true })
      success('Favicon updated')
    } catch (err) {
      await handleError(err, 'Could not upload this favicon')
    } finally {
      setFaviconBusy(false)
    }
  }, [error, handleError, loadTree, node, snap, success])

  const removeFavicon = useCallback(async () => {
    if (!snap || !node || node.kind !== 'bookmark') return
    if (!snap.capabilities.updateNode || node.readOnly) return
    setFaviconBusy(true)
    try {
      const intentId = productClient.mutationIntentKey(
        `delete-favicon:${snap.collection.id}:${node.id}`,
        productClient.newCommandId(),
      )
      await productClient.deleteBookmarkFavicon(snap.collection.id, node.id, { intentId })
      await loadTree(snap.collection.id, { silent: true })
      success('Favicon removed')
    } catch (err) {
      await handleError(err, 'Could not remove this favicon')
    } finally {
      setFaviconBusy(false)
    }
  }, [handleError, loadTree, node, snap, success])

  /** The drawer's own status line, with the Annotation state machine winning
      whenever it is the surface that needs attention. */
  const status = saving || faviconBusy
    ? message || 'Saving…'
    : ['saving', 'unknown', 'stale', 'conflict', 'error'].includes(annotation.state)
      ? annotation.message
      : message

  return {
    node,
    annotation,
    title,
    setTitle,
    url,
    setUrl,
    description,
    setDescription,
    tags,
    setTags,
    tagDraft,
    setTagDraft,
    tagVocabulary,
    tldrDraft: annotations.tldrDraft,
    setTldrDraft: annotations.setTldrDraft,
    tldrVisibility: annotations.tldrVisibility,
    setTldrVisibility: annotations.setTldrVisibility,
    noteVisibility: annotations.noteVisibility,
    setNoteVisibility: annotations.setNoteVisibility,
    dirty,
    saving,
    faviconBusy,
    status,
    save,
    uploadFavicon,
    removeFavicon,
  }
}

export type NodeEditDrawerState = ReturnType<typeof useNodeEditDrawer>
