import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { NavigateFunction } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  recoveryStrategyFor,
  type CollectionVisibility,
  type EditableNodeView,
  type EditorSnapshot,
} from '../../api'
import { useCancelConfirm, useConfirm } from '../../components/ConfirmModal'
import { useAnnotationWorkflow } from '../../lib/useAnnotationWorkflow'
import { useNodeAnnotationDraft } from '../../lib/useNodeAnnotationDraft'
import { childrenOf, etagForDelete, parentRevision, resolveEditableNode } from './treeModel'
import type { CursorRecoveryReason, EditorBanner, LoadState } from './types'

const BOOKMARK_FAVICON_MAX_BYTES = 65536

/** `a, b` ⇄ ["a", "b"] — shared with the desk drawer's node editor. */
function tagsFromInput(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
}

function tagsToInput(tags: readonly string[]): string {
  return tags.join(', ')
}

function isDeclaredRejectedFaviconType(type: string): boolean {
  const declared = type.trim().toLowerCase()
  return declared.includes('svg') || declared.includes('gif') || declared.includes('html')
}

export function useCollectionEditorMutations(options: {
  collectionId: string | undefined
  snap: EditorSnapshot | null
  reload: (opts?: {
    silent?: boolean
    preserveUserIntent?: boolean
    recoveryReason?: CursorRecoveryReason
  }) => Promise<void>
  setLoad: Dispatch<SetStateAction<LoadState>>
  setBanner: Dispatch<SetStateAction<EditorBanner | null>>
  preserveEditDraftRef: MutableRefObject<boolean>
  navigate: NavigateFunction
  toast: (message: string) => void
  success: (message: string) => void
  error: (message: string) => void
  refreshSession: () => Promise<void>
  bootstrapping: boolean
  isLoggedIn: boolean
  /** `?node=<id>` deep link: preselected once the snapshot carries the node. */
  initialNodeId?: string | null
}) {
  const {
    collectionId,
    snap,
    reload,
    setLoad,
    setBanner,
    preserveEditDraftRef,
    navigate,
    toast,
    success,
    error,
    refreshSession,
    bootstrapping,
    isLoggedIn,
    initialNodeId = null,
  } = options

  const confirm = useConfirm()
  const cancelConfirm = useCancelConfirm()
  const snapRef = useRef(snap)
  snapRef.current = snap

  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [visibility, setVisibility] = useState<CollectionVisibility>('private')
  const [publicationSlug, setPublicationSlug] = useState('')
  const [publicationDirty, setPublicationDirty] = useState(false)
  const [publicationSlugError, setPublicationSlugError] = useState<string | null>(null)
  const [titleError, setTitleError] = useState<string | null>(null)
  const publicationSlugRef = useRef<HTMLInputElement>(null)

  const [createKind, setCreateKind] = useState<'folder' | 'bookmark'>('bookmark')
  const [createTitle, setCreateTitle] = useState('')
  const [createUrl, setCreateUrl] = useState('https://')
  const [createParentId, setCreateParentId] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [editTitle, setEditTitle] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editTags, setEditTags] = useState('')
  const mutationControllerRef = useRef<AbortController | null>(null)
  const activeCollectionIdRef = useRef(collectionId)
  activeCollectionIdRef.current = collectionId

  const startMutation = useCallback(() => {
    mutationControllerRef.current?.abort()
    const controller = new AbortController()
    mutationControllerRef.current = controller
    setBusy(true)
    return controller
  }, [])
  const mutationIsCurrent = useCallback((controller: AbortController, expectedCollectionId: string) => (
    !controller.signal.aborted
    && mutationControllerRef.current === controller
    && activeCollectionIdRef.current === expectedCollectionId
  ), [])
  const finishMutation = useCallback((controller: AbortController, expectedCollectionId: string) => {
    if (!mutationIsCurrent(controller, expectedCollectionId)) return
    mutationControllerRef.current = null
    setBusy(false)
  }, [mutationIsCurrent])

  const hydrateFromSnapshot = useCallback((next: EditorSnapshot, preserveUserIntent: boolean) => {
    if (!preserveUserIntent) {
      setTitle(next.collection.title)
      setSummary(next.collection.summary ?? '')
      setVisibility(next.collection.visibility)
      setPublicationSlug(next.collection.publicationSlug ?? '')
      setPublicationDirty(false)
      setPublicationSlugError(null)
      setTitleError(null)
    }
    setCreateParentId((prev) => preserveUserIntent ? prev ?? next.root.id : next.root.id)
  }, [])

  useEffect(() => {
    mutationControllerRef.current?.abort()
    mutationControllerRef.current = null
    setBusy(false)
    return () => {
      mutationControllerRef.current?.abort()
      cancelConfirm()
    }
  }, [bootstrapping, isLoggedIn, collectionId, cancelConfirm])

  const caps = snap?.capabilities

  const selectedNode = useMemo(() => {
    if (!snap || !selectedId) return null
    if (selectedId === snap.root.id) return snap.root
    return snap.nodes.find((n) => n.id === selectedId) ?? null
  }, [snap, selectedId])

  /* The selected node's note/TL;DR, through the same workflow and draft hook
     as the library desk drawer (FE-04/FE-07 share one implementation). The
     root is a collection-level subject, not an editable node. */
  const annotationLocator = useMemo(() => (
    snap && selectedNode && selectedNode.id !== snap.root.id
      ? { collectionId: snap.collection.id, resourceType: 'node' as const, resourceId: selectedNode.id }
      : null
  ), [selectedNode, snap])
  const annotation = useAnnotationWorkflow(annotationLocator)
  const annotations = useNodeAnnotationDraft(annotation, annotationLocator !== null)

  /* Deep link entry: preselect the node named by ?node= as soon as it exists
     in the snapshot. A stale or foreign id is ignored, never an error. The
     ref keeps later refreshes from re-selecting after the user moved on. */
  const consumedNodeParamRef = useRef<string | null>(null)
  useEffect(() => {
    if (!snap || !initialNodeId) return
    if (consumedNodeParamRef.current === initialNodeId) return
    if (!snap.nodes.some((candidate) => candidate.id === initialNodeId) && initialNodeId !== snap.root.id) return
    consumedNodeParamRef.current = initialNodeId
    setSelectedId(initialNodeId)
  }, [initialNodeId, snap])

  useEffect(() => {
    if (preserveEditDraftRef.current) {
      preserveEditDraftRef.current = false
      return
    }
    if (!selectedNode) {
      setEditTitle('')
      setEditUrl('')
      setEditDescription('')
      setEditTags('')
      return
    }
    setEditTitle(selectedNode.title)
    setEditUrl(selectedNode.kind === 'bookmark' ? selectedNode.url : '')
    setEditDescription(selectedNode.description ?? '')
    setEditTags(tagsToInput(selectedNode.tags))
  }, [preserveEditDraftRef, selectedNode])

  const handleProductError = useCallback(
    async (err: unknown, actionLabel: string, controller: AbortController, expectedCollectionId: string) => {
      if (!mutationIsCurrent(controller, expectedCollectionId)) return
      if (!isProductApiError(err)) {
        error(`${actionLabel} failed`)
        return
      }
      const strategy = recoveryStrategyFor(err)
      const slugFieldError = err.fieldErrors.find((field) => field.path === '/publicationSlug')
      if (slugFieldError) {
        setPublicationSlugError(slugFieldError.message)
        requestAnimationFrame(() => {
          if (!controller.signal.aborted && activeCollectionIdRef.current === expectedCollectionId) publicationSlugRef.current?.focus()
        })
        return
      }
      setBanner({ message: err.recoveryHint, action: 'refresh' })

      switch (strategy) {
        case 'require_login':
          toast('Sign in required')
          navigate(`/login?returnTo=${encodeURIComponent(collectionId ? `/library/${collectionId}` : '/library')}`)
          break
        case 'rebootstrap_session':
          await refreshSession()
          toast('Your session was refreshed. Try again.')
          if (!mutationIsCurrent(controller, expectedCollectionId)) return
          await reload({ silent: true, preserveUserIntent: true })
          if (!mutationIsCurrent(controller, expectedCollectionId)) return
          setBanner({
            message: 'Session refreshed. Your unsaved form values were kept; review and retry the save.',
            action: 'review_drafts',
          })
          break
        case 'refresh_and_retry':
          toast('Conflict — refreshed. Re-apply your change.')
          await reload({ silent: true })
          break
        case 'restart_editor_from_first_page':
          toast('Snapshot expired — reloading tree…')
          await reload({
            silent: true,
            preserveUserIntent: true,
            recoveryReason: err.code as CursorRecoveryReason,
          })
          break
        case 'user_confirm_recursive':
          toast('Folder is not empty — try the delete again to confirm removing everything inside.')
          break
        case 'new_user_intent':
          toast(err.recoveryHint)
          await reload({ silent: true })
          break
        default:
          toast(err.recoveryHint || `${actionLabel} failed`)
      }
    },
    [collectionId, error, navigate, mutationIsCurrent, refreshSession, reload, setBanner, toast],
  )

  /** Resolves true once the collection itself saved, so the form can commit
      its catalog fields (tags, language) in the same Save. */
  const onSaveMeta = async (e: FormEvent): Promise<boolean> => {
    e.preventDefault()
    if (!snap || !caps?.updateCollection) return false
    const t = title.trim()
    if (!t) {
      setTitleError('Enter a title.')
      return false
    }
    const slug = publicationSlug.trim()
    if ((visibility === 'public' || visibility === 'unlisted')
      && !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug)) {
      const message = 'Public and unlisted collections need a lowercase slug (3–63 characters)'
      setPublicationSlugError(message)
      publicationSlugRef.current?.focus()
      error(message)
      return false
    }
    setPublicationSlugError(null)
    const operationCollectionId = snap.collection.id
    const controller = startMutation()
    try {
      const intentId = productClient.mutationIntentKey(
        `update-collection:${snap.collection.id}`,
        productClient.newCommandId(),
      )
      const result = await productClient.updateCollection(
        snap.collection.id,
        {
          title: t,
          summary: summary.trim() ? summary.trim() : null,
          ...(publicationDirty && visibility !== 'protected' ? { visibility } : {}),
          ...(publicationDirty && (visibility === 'public' || visibility === 'unlisted')
            ? { publicationSlug: slug }
            : {}),
        },
        snap.collection.etag,
        { intentId, signal: controller.signal },
      )
      if (!mutationIsCurrent(controller, operationCollectionId)) return false
      const updatedCollection = {
        ...result.collection,
        publicationSlug: result.collection.publicationSlug
          ?? snap.collection.publicationSlug
          ?? null,
        publishedAt: result.collection.publishedAt
          ?? snap.collection.publishedAt
          ?? null,
      }
      setLoad({
        status: 'ready',
        snap: { ...snap, collection: updatedCollection },
      })
      setTitle(updatedCollection.title)
      setSummary(updatedCollection.summary ?? '')
      setVisibility(updatedCollection.visibility)
      setPublicationSlug(updatedCollection.publicationSlug ?? '')
      setPublicationDirty(false)
      setPublicationSlugError(null)
      setTitleError(null)
      setBanner(null)
      success('Collection settings saved')
      return true
    } catch (err) {
      await handleProductError(err, 'Save collection', controller, operationCollectionId)
      return false
    } finally {
      finishMutation(controller, operationCollectionId)
    }
  }

  const onCreateNode = async (e: FormEvent) => {
    e.preventDefault()
    if (!snap || !caps?.createNode || !createParentId) return
    const t = createTitle.trim()
    if (!t) {
      error('Title is required')
      return
    }
    if (createKind === 'bookmark') {
      try {
        // Basic client check; server still validates HttpUrlNoUserInfo
        const u = new URL(createUrl.trim())
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          error('URL must be http or https')
          return
        }
      } catch {
        error('Enter a valid URL')
        return
      }
    }
    const operationCollectionId = snap.collection.id
    const controller = startMutation()
    try {
      const intentId = productClient.mutationIntentKey(
        `create-node:${snap.collection.id}:${createParentId}`,
        productClient.newCommandId(),
      )
      await productClient.createCollectionNode(
        snap.collection.id,
        {
          parentId: createParentId,
          afterId: null,
          beforeId: null,
          node:
            createKind === 'folder'
              ? {
                  kind: 'folder',
                  title: t,
                  description: null,
                  tags: [],
                  visibility: 'inherit',
                }
              : {
                  kind: 'bookmark',
                  title: t,
                  url: createUrl.trim(),
                  description: null,
                  tags: [],
                  visibility: 'inherit',
                },
        },
        { intentId, signal: controller.signal },
      )
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      setCreateTitle('')
      setCreateUrl('https://')
      success(createKind === 'folder' ? 'Folder created' : 'Bookmark created')
      await reload({ silent: true })
    } catch (err) {
      await handleProductError(err, createKind === 'folder' ? 'Create folder' : 'Create bookmark', controller, operationCollectionId)
    } finally {
      finishMutation(controller, operationCollectionId)
    }
  }

  const onSaveNode = async () => {
    if (!snap || !selectedNode || selectedNode.id === snap.root.id) return
    if (!caps?.updateNode) return
    if (selectedNode.readOnly) {
      toast(selectedNode.readOnlyReason || (selectedNode.kind === 'folder' ? 'This folder is read-only' : 'This bookmark is read-only'))
      return
    }
    const t = editTitle.trim()
    if (!t) {
      error('Title is required')
      return
    }
    const operationCollectionId = snap.collection.id
    const controller = startMutation()
    try {
      const intentId = productClient.mutationIntentKey(
        `update-node:${selectedNode.id}`,
        productClient.newCommandId(),
      )
      const nextDescription = editDescription.trim() ? editDescription.trim() : null
      const nextTags = tagsFromInput(editTags)
      const body =
        selectedNode.kind === 'bookmark'
          ? { title: t, url: editUrl.trim(), description: nextDescription, tags: nextTags }
          : { title: t, description: nextDescription, tags: nextTags }
      await productClient.updateCollectionNode(
        snap.collection.id,
        selectedNode.id,
        body,
        selectedNode.etag,
        { intentId, signal: controller.signal },
      )
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      // The note/TL;DR half rides the same Save, through the shared workflow.
      // A rejected annotation write must not report a clean "updated".
      if (!(await annotations.save())) {
        setBanner({ message: 'The node saved, but its Note or TL;DR still needs attention.', action: 'review_drafts' })
        return
      }
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      success(selectedNode.kind === 'folder' ? 'Folder updated' : 'Bookmark updated')
      await reload({ silent: true })
    } catch (err) {
      await handleProductError(err, selectedNode.kind === 'folder' ? 'Update folder' : 'Update bookmark', controller, operationCollectionId)
    } finally {
      finishMutation(controller, operationCollectionId)
    }
  }

  const onUploadFavicon = async (file: File | undefined) => {
    if (!file || !snap || !selectedNode || selectedNode.kind !== 'bookmark' || !selectedNode.id) return
    if (!caps?.updateNode || selectedNode.readOnly) return
    if (file.size > BOOKMARK_FAVICON_MAX_BYTES) {
      error('Favicon must be 65536 bytes or smaller')
      return
    }
    if (isDeclaredRejectedFaviconType(file.type)) {
      error('Favicon cannot be SVG, GIF, or HTML')
      return
    }
    const operationCollectionId = snap.collection.id
    const nodeId = selectedNode.id
    const controller = startMutation()
    try {
      const intentId = productClient.mutationIntentKey(
        `upload-favicon:${snap.collection.id}:${nodeId}`,
        productClient.newCommandId(),
      )
      const updated = await productClient.uploadBookmarkFavicon(
        snap.collection.id,
        nodeId,
        file,
        { intentId, signal: controller.signal },
      )
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      preserveEditDraftRef.current = true
      setLoad({
        status: 'ready',
        snap: {
          ...snap,
          nodes: snap.nodes.map((node) => (node.id === updated.id ? updated : node)),
        },
      })
      success('Favicon updated')
    } catch (err) {
      await handleProductError(err, 'Upload favicon', controller, operationCollectionId)
    } finally {
      finishMutation(controller, operationCollectionId)
    }
  }

  const onDeleteFavicon = async () => {
    if (!snap || !selectedNode || selectedNode.kind !== 'bookmark' || !selectedNode.id) return
    if (!caps?.updateNode || selectedNode.readOnly) return
    const operationCollectionId = snap.collection.id
    const nodeId = selectedNode.id
    const controller = startMutation()
    try {
      const intentId = productClient.mutationIntentKey(
        `delete-favicon:${snap.collection.id}:${nodeId}`,
        productClient.newCommandId(),
      )
      const updated = await productClient.deleteBookmarkFavicon(
        snap.collection.id,
        nodeId,
        { intentId, signal: controller.signal },
      )
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      preserveEditDraftRef.current = true
      setLoad({
        status: 'ready',
        snap: {
          ...snap,
          nodes: snap.nodes.map((node) => (node.id === updated.id ? updated : node)),
        },
      })
      success('Favicon removed')
    } catch (err) {
      await handleProductError(err, 'Remove favicon', controller, operationCollectionId)
    } finally {
      finishMutation(controller, operationCollectionId)
    }
  }

  const onMove = async (node: EditableNodeView, dir: -1 | 1) => {
    if (!snap || !caps?.moveNode || node.readOnly) return
    const siblings = childrenOf(node.parentId, snap.nodes)
    const idx = siblings.findIndex((s) => s.id === node.id)
    const swap = siblings[idx + dir]
    if (!swap || idx < 0) return

    const newAfterId = dir === -1 ? (siblings[idx - 2]?.id ?? null) : swap.id
    const newBeforeId = dir === -1 ? swap.id : (siblings[idx + 2]?.id ?? null)

    const operationCollectionId = snap.collection.id
    const controller = startMutation()
    try {
      const parentRev = parentRevision(node.parentId, snap.root, snap.nodes)
      const intentId = productClient.mutationIntentKey(
        `move-node:${node.id}`,
        productClient.newCommandId(),
      )
      await productClient.moveCollectionNode(
        snap.collection.id,
        node.id,
        {
          newParentId: node.parentId,
          afterId: newAfterId,
          beforeId: newBeforeId,
          baseSourceParentRevision: parentRev,
          baseTargetParentRevision: parentRev,
        },
        node.etag,
        { intentId, signal: controller.signal },
      )
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      await reload({ silent: true })
    } catch (err) {
      await handleProductError(err, node.kind === 'folder' ? 'Move folder' : 'Move bookmark', controller, operationCollectionId)
    } finally {
      finishMutation(controller, operationCollectionId)
    }
  }

  const executeDelete = async (nodeId: string, recursive: boolean, doneMessage = 'Deleted') => {
    const live = snapRef.current
    if (!live?.capabilities.deleteNode) return
    const node = resolveEditableNode(live, nodeId)
    if (!node) {
      error('Item no longer exists')
      return
    }
    if (node.readOnly) return
    const { nodeEtag, contentEtag } = etagForDelete(live, node)
    const operationCollectionId = live.collection.id
    const controller = startMutation()
    let retryRecursive = false
    try {
      const intentId = productClient.mutationIntentKey(
        `delete-node:${node.id}`,
        productClient.newCommandId(),
      )
      await productClient.deleteCollectionNode(live.collection.id, node.id, nodeEtag, {
        intentId,
        recursive,
        ifContentMatch: recursive ? contentEtag : undefined,
        signal: controller.signal,
      })
      if (!mutationIsCurrent(controller, operationCollectionId)) return
      if (selectedIdRef.current === node.id) setSelectedId(null)
      success(doneMessage)
      await reload({ silent: true })
    } catch (err) {
      if (isProductApiError(err) && err.isFolderNotEmpty) {
        // Drop busy before the second prompt so the tree stays operable.
        retryRecursive = true
        return
      }
      await handleProductError(err, node.kind === 'folder' ? 'Delete folder' : 'Delete bookmark', controller, operationCollectionId)
    } finally {
      finishMutation(controller, operationCollectionId)
    }
    if (!retryRecursive) return
    const ok = await confirm({
      title: 'Folder is not empty',
      body: 'This folder is not empty. Delete it and everything inside?',
      confirmLabel: 'Delete everything',
    })
    if (ok) await executeDelete(nodeId, true, 'Folder deleted')
  }

  const onDelete = (node: EditableNodeView) => {
    const live = snapRef.current
    if (!live?.capabilities.deleteNode || node.readOnly) return

    if (node.kind === 'folder') {
      const recursive = live.nodes.some((n) => n.parentId === node.id)
      void confirm({
        title: 'Delete folder',
        body: recursive
          ? `Delete folder “${node.title}” and everything inside?`
          : `Delete empty folder “${node.title}”?`,
        confirmLabel: 'Delete folder',
      }).then((ok) => {
        if (ok) void executeDelete(node.id, recursive)
      })
      return
    }

    void confirm({
      title: 'Delete bookmark',
      body: `Delete bookmark “${node.title}”?`,
      confirmLabel: 'Delete',
    }).then((ok) => {
      if (ok) void executeDelete(node.id, false)
    })
  }

  return {
    hydrateFromSnapshot,
    busy,
    caps,
    title,
    setTitle,
    summary,
    setSummary,
    visibility,
    setVisibility,
    publicationSlug,
    setPublicationSlug,
    publicationDirty,
    setPublicationDirty,
    publicationSlugError,
    setPublicationSlugError,
    titleError,
    setTitleError,
    publicationSlugRef,
    createKind,
    setCreateKind,
    createTitle,
    setCreateTitle,
    createUrl,
    setCreateUrl,
    createParentId,
    setCreateParentId,
    selectedId,
    setSelectedId,
    selectedNode,
    editTitle,
    setEditTitle,
    editUrl,
    setEditUrl,
    editDescription,
    setEditDescription,
    editTags,
    setEditTags,
    annotation,
    annotations,
    onSaveMeta,
    onCreateNode,
    onSaveNode,
    onUploadFavicon,
    onDeleteFavicon,
    onMove,
    onDelete,
  }
}

export type CollectionEditorMutations = ReturnType<typeof useCollectionEditorMutations>
