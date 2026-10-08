import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isProductApiError, productClient, type EditableNodeView, type RelationType, type RelationView, type RelationVisibility } from '../api'
import { useConfirm, useConfirmLeaveGuard } from '../components/ConfirmModal'
import { plural } from './plural'
import { hostOf } from './libraryTree'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'

export type RelationLocator = { collectionId: string; nodeId: string }
/** Pickers disambiguate same-titled endpoints by host (bookmarks) or kind label — never by internal id. */
export type RelationNodeOption = Pick<EditableNodeView, 'id' | 'title' | 'kind'> & { host: string | null }
export function relationEndpointDisambiguator(option: Pick<RelationNodeOption, 'kind' | 'host'>): string {
  return option.kind === 'bookmark' ? (option.host ?? 'bookmark') : 'folder'
}
type SaveState = 'loading' | 'ready' | 'saving' | 'unknown' | 'stale' | 'conflict' | 'error'
type PendingUpdate = { relationId: string; patch: { type: RelationType; label: string | null; visibility: RelationVisibility }; ifMatch: string; intentId: string }
type PendingCreate = { input: { endpointId: string; type: RelationType; label: string; visibility: RelationVisibility }; intentId: string }
type PendingDelete = { relation: RelationView; intentId: string }
type PendingReplacement = {
  relation: RelationView
  endpointId: string
  type: RelationType
  label: string
  visibility: RelationVisibility
  deleteIntentId: string
  createIntentId: string
  phase: 'delete' | 'create'
}
const etag = (relation: RelationView) => `"${relation.revision.replaceAll('"', '')}"`

export function useRelationWorkflow(locator: RelationLocator | null, draftDirty = false) {
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [nodes, setNodes] = useState<RelationNodeOption[]>([])
  const [incoming, setIncoming] = useState<RelationView[]>([])
  const [outgoing, setOutgoing] = useState<RelationView[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [createdCount, setCreatedCount] = useState(0)
  const [state, setState] = useState<SaveState>('loading')
  const [message, setMessage] = useState('Loading relations')
  const [editing, setEditing] = useState<RelationView | null>(null)
  const [editDraft, setEditDraft] = useState<{ type: RelationType; label: string; visibility: RelationVisibility; replacementEndpointId: string }>({ type: 'related', label: '', visibility: 'private', replacementEndpointId: '' })
  const pendingRef = useRef<PendingUpdate | null>(null)
  const pendingCreateRef = useRef<PendingCreate | null>(null)
  const pendingDeleteRef = useRef<PendingDelete | null>(null)
  const pendingReplacementRef = useRef<PendingReplacement | null>(null)
  const confirm = useConfirm()
  const generationRef = useRef(0)
  const identityRef = useRef(sessionIdentity)
  const loadControllerRef = useRef<AbortController | null>(null)
  const mutationControllerRef = useRef<AbortController | null>(null)
  /* Mirrors so async code reads the current draft instead of a stale closure. */
  const editingRef = useRef<RelationView | null>(null)
  const dirtyRef = useRef(false)
  const syncEditing = useCallback((next: RelationView | null) => { editingRef.current = next; setEditing(next) }, [])

  const load = useCallback(async (preserveAccess = false) => {
    if (!locator) { setCanEdit(false); setNodes([]); setIncoming([]); setOutgoing([]); setState('ready'); setMessage('Open this bookmark from its collection to manage relations.'); return false }
    const requestIdentity = sessionIdentity
    const generation = ++generationRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    /* Post-mutation reloads keep the grant (the mutation controls stay
       mounted but locked); mount and manual reloads re-verify from scratch
       so a stale entry cannot linger while access is rechecked. */
    if (!preserveAccess) setCanEdit(false)
    setState('loading'); setMessage('Loading relations')
    try {
      const [editor, nextIncoming, nextOutgoing] = await Promise.all([
        productClient.loadEditorSnapshot(locator.collectionId, { signal: controller.signal, maxRetries: 0 }),
        productClient.loadRelations(locator.collectionId, { nodeId: locator.nodeId, direction: 'incoming' }, { signal: controller.signal, maxRetries: 0 }),
        productClient.loadRelations(locator.collectionId, { nodeId: locator.nodeId, direction: 'outgoing' }, { signal: controller.signal, maxRetries: 0 }),
      ])
      if (controller.signal.aborted || generation !== generationRef.current
        || privateSessionIdentity() !== requestIdentity) return false
      setCanEdit(editor.capabilities.updateNode)
      setNodes([editor.root, ...editor.nodes].filter((node) => node.id !== locator.nodeId).map((node) => (
        { id: node.id, title: node.title, kind: node.kind, host: node.kind === 'bookmark' && 'url' in node && node.url ? hostOf(node.url) : null }
      )))
      setIncoming(nextIncoming); setOutgoing(nextOutgoing); setState('ready'); setMessage(plural(nextIncoming.length + nextOutgoing.length, 'relation'))
      /* Re-basing `editing` onto the server copy must not silently arm the
         save path with a fresh etag: a dirty draft over a moved revision
         surfaces as 'stale' so the overwrite is informed; a clean draft just
         adopts the refreshed values. */
      const currentEditing = editingRef.current
      const found = currentEditing ? [...nextOutgoing, ...nextIncoming].find((relation) => relation.id === currentEditing.id) ?? null : null
      syncEditing(found)
      if (currentEditing && found === null) {
        setState('stale'); setMessage('This relation was removed on the server.')
        return 'removed'
      }
      if (currentEditing && found && found.revision !== currentEditing.revision) {
        if (dirtyRef.current) {
          setState('stale'); setMessage('This relation changed on the server. Review the refreshed relation and save again.')
          return 'stale'
        }
        setEditDraft({ type: found.type, label: found.label ?? '', visibility: found.visibility, replacementEndpointId: found.fromNodeId === locator.nodeId ? found.toNodeId : found.fromNodeId })
      }
      return 'ready'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false
      if (controller.signal.aborted || generation !== generationRef.current
        || privateSessionIdentity() !== requestIdentity) return false
      setCanEdit(false)
      setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load relations")
      return false
    }
  }, [locator, syncEditing, sessionIdentity])

  useEffect(() => {
    const changed = identityRef.current !== sessionIdentity
    identityRef.current = sessionIdentity
    if (changed) {
      generationRef.current += 1
      loadControllerRef.current?.abort()
      mutationControllerRef.current?.abort()
      pendingRef.current = null
      pendingCreateRef.current = null
      pendingDeleteRef.current = null
      pendingReplacementRef.current = null
      editingRef.current = null
      dirtyRef.current = false
      setNodes([])
      setIncoming([])
      setOutgoing([])
      setCanEdit(false)
      setCreatedCount(0)
      setState('loading')
      setMessage('Loading relations')
      setEditing(null)
      setEditDraft({ type: 'related', label: '', visibility: 'private', replacementEndpointId: '' })
    }
    void load()
    return () => {
      generationRef.current += 1
      loadControllerRef.current?.abort()
      mutationControllerRef.current?.abort()
    }
  }, [load, sessionIdentity])

  const executeCreate = useCallback(async (pending: PendingCreate) => {
    const input = pending.input
    if (!canEdit || !locator || !input.endpointId || input.endpointId === locator.nodeId || !nodes.some((node) => node.id === input.endpointId)) return
    const requestIdentity = sessionIdentity
    pendingCreateRef.current = pending
    mutationControllerRef.current?.abort()
    const controller = new AbortController()
    mutationControllerRef.current = controller
    const generation = generationRef.current
    setState('saving'); setMessage('Creating relation')
    try {
      await productClient.createRelation(locator.collectionId, { fromNodeId: locator.nodeId, toNodeId: input.endpointId, type: input.type, ...(input.label.trim() ? { label: input.label.trim() } : {}), visibility: input.visibility }, { intentId: pending.intentId, maxRetries: 0, clearIntentOnSuccess: true, signal: controller.signal })
      /* An aborted controller means a newer mutation owns the pending refs —
         leave them. A bare generation bump (e.g. a manual reload landing
         mid-flight) means this command still succeeded on the server, so the
         consumed intent and the create count must settle here. */
      if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
      pendingCreateRef.current = null
      setCreatedCount((count) => count + 1)
      if (generation !== generationRef.current || privateSessionIdentity() !== requestIdentity) return
      const refreshed = await load(true)
      if (refreshed === 'ready' && generationRef.current === generation + 1) setMessage('Relation created')
    } catch (error) {
      if (generation !== generationRef.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return
      if (isProductApiError(error) && error.code === 'transport_error') { setState('unknown'); setMessage('The relation may not have been created. Try again before making other changes.'); return }
      if (isProductApiError(error) && error.code === 'command_id_reused') { setState('conflict'); setMessage('This action conflicts with an earlier request. Try again.'); return }
      setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : 'Relation could not be created')
    }
  }, [canEdit, load, locator, nodes, sessionIdentity])

  const create = useCallback((input: { endpointId: string; type: RelationType; label: string; visibility: RelationVisibility }, forceNew = false) => {
    if (!canEdit) return
    const existing = pendingCreateRef.current
    if (!forceNew && existing && state === 'unknown') { void executeCreate(existing); return }
    if (existing) productClient.abandonRelationIntent(existing.intentId)
    void executeCreate({ input: { ...input }, intentId: productClient.mutationIntentKey('create-relation', productClient.newCommandId()) })
  }, [canEdit, executeCreate, state])

  const beginEdit = useCallback((relation: RelationView) => {
    if (!canEdit) return
    pendingRef.current = null; syncEditing(relation); setEditDraft({ type: relation.type, label: relation.label ?? '', visibility: relation.visibility, replacementEndpointId: relation.fromNodeId === locator?.nodeId ? relation.toNodeId : relation.fromNodeId }); setState('ready'); setMessage('Editing relation')
  }, [canEdit, locator?.nodeId, syncEditing])

  const executeUpdate = useCallback(async (pending: PendingUpdate) => {
    if (!canEdit || !locator) return
    const requestIdentity = sessionIdentity
    mutationControllerRef.current?.abort()
    const controller = new AbortController()
    mutationControllerRef.current = controller
    const generation = generationRef.current
    pendingRef.current = pending; setState('saving'); setMessage('Saving relation')
    try {
      const updated = await productClient.updateRelation(locator.collectionId, pending.relationId, pending.patch, pending.ifMatch, { intentId: pending.intentId, maxRetries: 0, clearIntentOnSuccess: true, signal: controller.signal })
      if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
      pendingRef.current = null; syncEditing(updated); setEditDraft((draft) => ({ ...draft, type: updated.type, label: updated.label ?? '', visibility: updated.visibility }))
      if (generation !== generationRef.current || privateSessionIdentity() !== requestIdentity) return
      const refreshed = await load(true)
      if (refreshed === 'ready' && generationRef.current === generation + 1) setMessage('Relation saved')
    } catch (error) {
      if (generation !== generationRef.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return
      if (isProductApiError(error) && error.code === 'precondition_failed') { productClient.abandonRelationIntent(pending.intentId); pendingRef.current = null; const refreshed = await load(true); if (refreshed && generationRef.current === generation + 1) { setState('stale'); setMessage('This relation changed on the server. Review the refreshed relation and save again.') } return }
      if (isProductApiError(error) && error.code === 'transport_error') { setState('unknown'); setMessage('The relation may not have been saved. Try again.'); return }
      if (isProductApiError(error) && error.code === 'command_id_reused') { setState('conflict'); setMessage('This action conflicts with an earlier request. Try again.'); return }
      setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : 'Relation could not be saved')
    }
  }, [canEdit, load, locator, syncEditing, sessionIdentity])

  const save = useCallback((forceNew = false) => {
    if (!canEdit || !editing) return
    const existing = pendingRef.current
    if (!forceNew && existing && state === 'unknown') { void executeUpdate(existing); return }
    if (existing) productClient.abandonRelationIntent(existing.intentId)
    void executeUpdate({ relationId: editing.id, patch: { type: editDraft.type, label: editDraft.label.trim() || null, visibility: editDraft.visibility }, ifMatch: etag(editing), intentId: productClient.mutationIntentKey('update-relation', productClient.newCommandId()) })
  }, [canEdit, editDraft, editing, executeUpdate, state])

  const executeDelete = useCallback(async (pending: PendingDelete) => {
    if (!canEdit || !locator) return false
    const requestIdentity = sessionIdentity
    mutationControllerRef.current?.abort()
    const controller = new AbortController()
    mutationControllerRef.current = controller
    const generation = generationRef.current
    pendingDeleteRef.current = pending
    setState('saving'); setMessage('Deleting relation')
    try {
      await productClient.deleteRelation(locator.collectionId, pending.relation.id, etag(pending.relation), { intentId: pending.intentId, maxRetries: 0, signal: controller.signal })
      if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return false
      pendingDeleteRef.current = null; syncEditing(null)
      if (generation !== generationRef.current || privateSessionIdentity() !== requestIdentity) return false
      const refreshed = await load(true)
      if (refreshed === 'ready' && generationRef.current === generation + 1) setMessage('Relation deleted')
      return true
    } catch (error) {
      if (generation !== generationRef.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return false
      if (isProductApiError(error) && error.code === 'precondition_failed') {
        productClient.abandonRelationIntent(pending.intentId); pendingDeleteRef.current = null
        const refreshed = await load(true); if (refreshed && generationRef.current === generation + 1) { setState('stale'); setMessage('This relation changed on the server. Review the refreshed list before deleting again.') } return false
      }
      if (isProductApiError(error) && error.code === 'transport_error') { setState('unknown'); setMessage('The relation may not have been deleted. Try again.'); return false }
      if (isProductApiError(error) && error.code === 'command_id_reused') { setState('conflict'); setMessage('This action conflicts with an earlier request. Try again.'); return false }
      setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : 'Relation could not be deleted'); return false
    }
  }, [canEdit, load, locator, syncEditing, sessionIdentity])

  const remove = useCallback(async (relation: RelationView, intentScope = 'delete-relation') => {
    if (!canEdit || !locator) return false
    const requestIdentity = sessionIdentity
    // R9-19: shared destructive confirm (Modal tone="danger") replaces the
    // native window.confirm.
    if (!(await confirm({ title: 'Delete this relation?', body: "This can't be undone.", confirmLabel: 'Delete relation' }))) return false
    if (privateSessionIdentity() !== requestIdentity) return false
    return executeDelete({ relation, intentId: productClient.mutationIntentKey(intentScope, productClient.newCommandId()) })
  }, [canEdit, confirm, executeDelete, locator, sessionIdentity])

  const executeReplacement = useCallback(async (pending: PendingReplacement) => {
    if (!canEdit || !locator) return
    const requestIdentity = sessionIdentity
    mutationControllerRef.current?.abort()
    const controller = new AbortController()
    mutationControllerRef.current = controller
    const generation = generationRef.current
    pendingReplacementRef.current = pending
    setState('saving'); setMessage('Replacing linked bookmark')
    try {
      if (pending.phase === 'delete') {
        await productClient.deleteRelation(locator.collectionId, pending.relation.id, etag(pending.relation), { intentId: pending.deleteIntentId, maxRetries: 0, signal: controller.signal })
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        /* The delete already landed, so a retry after a mid-flight reload
           must resume at create — never replay a consumed delete intent. */
        pending.phase = 'create'
        if (generation !== generationRef.current) return
      }
      const outgoingDirection = pending.relation.fromNodeId === locator.nodeId
      await productClient.createRelation(locator.collectionId, { fromNodeId: outgoingDirection ? locator.nodeId : pending.endpointId, toNodeId: outgoingDirection ? pending.endpointId : locator.nodeId, type: pending.type, ...(pending.label.trim() ? { label: pending.label.trim() } : {}), visibility: pending.visibility }, { intentId: pending.createIntentId, maxRetries: 0, signal: controller.signal })
      if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
      pendingReplacementRef.current = null
      syncEditing(null)
      if (generation !== generationRef.current || privateSessionIdentity() !== requestIdentity) return
      const refreshed = await load(true)
      if (refreshed === 'ready' && generationRef.current === generation + 1) setMessage('Linked bookmark replaced')
    } catch (error) {
      if (generation !== generationRef.current || controller.signal.aborted
        || privateSessionIdentity() !== requestIdentity) return
      if (isProductApiError(error) && error.code === 'transport_error') { setState('unknown'); setMessage('The replacement may not have finished. Try again.'); return }
      if (isProductApiError(error) && error.code === 'command_id_reused') { setState('conflict'); setMessage('This action conflicts with an earlier request. Try again.'); return }
      setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : 'The replacement did not complete. Refresh before trying again.')
    }
  }, [canEdit, load, locator, syncEditing, sessionIdentity])

  const replaceEndpoint = useCallback(async () => {
    if (!canEdit || !locator || !editing || !editDraft.replacementEndpointId || editDraft.replacementEndpointId === locator.nodeId) return
    const requestIdentity = sessionIdentity
    if (!nodes.some((node) => node.id === editDraft.replacementEndpointId)) { setState('error'); setMessage('Choose a bookmark from this collection.'); return }
    if (!(await confirm({
      title: 'Replace the linked bookmark?',
      body: 'Deletes the current relation and creates a new one.',
      confirmLabel: 'Replace',
    }))) return
    if (privateSessionIdentity() !== requestIdentity) return
    await executeReplacement({
      relation: editing,
      endpointId: editDraft.replacementEndpointId,
      type: editDraft.type,
      label: editDraft.label,
      visibility: editDraft.visibility,
      deleteIntentId: productClient.mutationIntentKey('replace-delete', productClient.newCommandId()),
      createIntentId: productClient.mutationIntentKey('replace-create', productClient.newCommandId()),
      phase: 'delete',
    })
  }, [canEdit, confirm, editDraft, editing, executeReplacement, locator, nodes, sessionIdentity])

  const dirty = !!editing && (editDraft.type !== editing.type || editDraft.label !== (editing.label ?? '') || editDraft.visibility !== editing.visibility || editDraft.replacementEndpointId !== (editing.fromNodeId === locator?.nodeId ? editing.toNodeId : editing.fromNodeId))
  dirtyRef.current = dirty
  // R9-19: the shared async confirm guards in-app navigation; beforeunload
  // stays native inside the hook.
  useConfirmLeaveGuard(draftDirty || dirty || ['saving', 'unknown', 'stale', 'conflict'].includes(state), {
    title: 'Discard changes?',
    body: 'You have unsaved changes on this page.',
    confirmLabel: 'Discard',
  })

  const retryPending = useCallback(() => {
    if (pendingReplacementRef.current) void executeReplacement(pendingReplacementRef.current)
    else if (pendingCreateRef.current) void executeCreate(pendingCreateRef.current)
    else if (pendingDeleteRef.current) void executeDelete(pendingDeleteRef.current)
    else save(false)
  }, [executeCreate, executeDelete, executeReplacement, save])
  const startNewPending = useCallback(() => {
    if (pendingReplacementRef.current) {
      const pending = pendingReplacementRef.current
      productClient.abandonRelationIntent(pending.phase === 'delete' ? pending.deleteIntentId : pending.createIntentId)
      if (pending.phase === 'create') {
        pending.createIntentId = productClient.mutationIntentKey('replace-create', productClient.newCommandId())
        void executeReplacement(pending)
      } else {
        pendingReplacementRef.current = null
        syncEditing(null)
        void load().then((refreshed) => { if (!refreshed) return; setState('stale'); setMessage('The relation was refreshed. Review it before replacing the linked bookmark again.') })
      }
    }
    else if (pendingCreateRef.current) create(pendingCreateRef.current.input, true)
    else if (pendingDeleteRef.current) {
      productClient.abandonRelationIntent(pendingDeleteRef.current.intentId)
      const relation = pendingDeleteRef.current.relation
      pendingDeleteRef.current = null
      void executeDelete({ relation, intentId: productClient.mutationIntentKey('delete-relation', productClient.newCommandId()) })
    }
    else save(true)
  }, [create, executeDelete, executeReplacement, load, save, syncEditing])

  // `useEffect` performs the destructive reset after an identity notification.
  // Gate the render before that effect runs so a new account never receives a
  // frame containing the previous account's relation graph or draft.
  const identityReady = identityRef.current === sessionIdentity

  return useMemo(() => ({
    canEdit: identityReady ? canEdit : false,
    createdCount: identityReady ? createdCount : 0,
    nodes: identityReady ? nodes : [],
    incoming: identityReady ? incoming : [],
    outgoing: identityReady ? outgoing : [],
    state: identityReady ? state : 'loading' as SaveState,
    message: identityReady ? message : 'Loading relations',
    editing: identityReady ? editing : null,
    editDraft: identityReady ? editDraft : {
      type: 'related' as RelationType, label: '', visibility: 'private' as RelationVisibility,
      replacementEndpointId: '',
    },
    setEditDraft, create, beginEdit, save, retry: retryPending, startNew: startNewPending,
    remove, replaceEndpoint,
    cancelEdit: () => { pendingRef.current = null; syncEditing(null); setState('ready'); setMessage(plural(incoming.length + outgoing.length, 'relation')) },
    reload: load,
  }), [beginEdit, canEdit, create, createdCount, editDraft, editing, identityReady, incoming, load, message, nodes,
    outgoing, remove, replaceEndpoint, retryPending, save, setEditDraft, startNewPending, state,
    syncEditing])
}
