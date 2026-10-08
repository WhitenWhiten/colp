import { useCallback, useRef } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import type { EditorSnapshot } from '../../api'
import { useConfirm } from '../../components/ConfirmModal'
import { FaviconDropCard } from '../../components/FaviconDropCard'
import { FaviconSourceControl } from '../../components/FaviconSourceControl'
import { PreviewModeControl } from '../../components/PreviewModeControl'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { NodeAnnotationFields } from '../../components/NodeAnnotationFields'
import { TagInput } from '../../components/TagInput'
import { bookmarkIconSrc } from '../../lib/bookmarkIcon'
import {
  NODE_DESCRIPTION_MAX,
  NODE_TITLE_MAX,
  NODE_URL_MAX,
  useNodeEditDrawer,
} from './nodeEditDrawer'

/**
 * FE-04: the node editor drawer. One surface edits everything a bookmark or
 * folder carries — title, URL (bookmark), description, tags, favicon
 * (bookmark), note and TL;DR. The overlay assembly is Modal chrome="sheet":
 * scroll lock, focus trap, Esc, exit beat and the top-of-stack check all
 * come from the shared component.
 */
export function NodeEditDrawer({
  snap,
  nodeId,
  onClose,
  loadTree,
  navigate,
  toast,
  success,
  error,
  refreshSession,
}: {
  snap: EditorSnapshot | null
  /** null closes the drawer; the last id is kept for the exit frame. */
  nodeId: string | null
  onClose: () => void
  loadTree: (key: string, opts?: { silent?: boolean }) => Promise<void>
  navigate: NavigateFunction
  toast: (message: string) => void
  success: (message: string) => void
  error: (message: string) => void
  refreshSession: () => Promise<void>
}) {
  const lastIdRef = useRef<string | null>(nodeId)
  if (nodeId) lastIdRef.current = nodeId
  const targetId = nodeId ?? lastIdRef.current

  const drawer = useNodeEditDrawer({
    snap,
    nodeId: targetId,
    open: nodeId !== null,
    loadTree,
    navigate,
    toast,
    success,
    error,
    refreshSession,
  })

  const node = drawer.node
  const dirty = drawer.dirty
  // R9-19: unsaved-close goes through the shared confirm (Modal
  // tone="danger"), not window.confirm.
  const confirm = useConfirm()

  const confirmDiscard = useCallback(
    () => confirm({
      title: 'Close this editor?',
      body: 'You have unsaved changes to this item.',
      confirmLabel: 'Discard changes',
    }),
    [confirm],
  )

  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose()
      return
    }
    void confirmDiscard().then((ok) => { if (ok) onClose() })
  }, [confirmDiscard, dirty, onClose])

  if (!node) return null

  const canEdit = Boolean(snap?.capabilities.updateNode) && !node.readOnly
  const isBookmark = node.kind === 'bookmark'
  const favicon = isBookmark
    // Same library posture as bookmarkItem: never hotlink CDN favicons
    // for private nodes (see LibraryDesk.bookmark-icon.test).
    ? bookmarkIconSrc({ iconUrl: node.iconUrl, pageUrl: node.url, faviconCdnAllowed: false })
    : null
  const faviconUrl = favicon?.kind === 'object' ? favicon.src : null
  return (
    <Modal
      open={nodeId !== null}
      onClose={requestClose}
      chrome="sheet"
      label={`${isBookmark ? 'Bookmark' : 'Folder'} editor`}
      labelledBy="node-drawer-title node-drawer-subject"
      overlayClassName="node-drawer-veil"
      overlayProps={{ 'data-testid': 'node-drawer-veil' }}
      panelClassName="node-drawer"
      panelProps={{ 'data-testid': 'node-drawer' }}
      initialFocus="#nd-title"
    >
    <header className="node-drawer-head">
      <span className="chip chip--label" id="node-drawer-title">
        {isBookmark ? 'Bookmark' : 'Folder'}
      </span>
      {/* The subject stays visible while its fields scroll — on the
          full-screen phone sheet this is the only orientation cue. */}
      <span className="node-drawer-subject" id="node-drawer-subject" title={node.title}>
        {node.title}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm node-drawer-close"
        aria-label="Close editor"
        onClick={requestClose}
      >
        <Icon name="cross" />
      </button>
    </header>
    <div className="node-drawer-body">
      {!canEdit && (
        <p className="field-hint" role="note">
          {node.readOnlyReason || (isBookmark ? 'You can view this bookmark but not edit it.' : 'You can view this folder but not edit it.')}
        </p>
      )}
      <div className="field">
        <label htmlFor="nd-title">Title</label>
        <input
          id="nd-title"
          value={drawer.title}
          maxLength={NODE_TITLE_MAX}
          disabled={!canEdit}
          onChange={(event) => drawer.setTitle(event.target.value)}
        />
      </div>
      {isBookmark && (
        <div className="field">
          <label htmlFor="nd-url">URL</label>
          <input
            id="nd-url"
            inputMode="url"
            maxLength={NODE_URL_MAX}
            value={drawer.url}
            disabled={!canEdit}
            onChange={(event) => drawer.setUrl(event.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="nd-desc">Description</label>
        <textarea
          id="nd-desc"
          rows={2}
          maxLength={NODE_DESCRIPTION_MAX}
          placeholder="What this link is, in one line…"
          value={drawer.description}
          disabled={!canEdit}
          onChange={(event) => drawer.setDescription(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="nd-tags">Tags</label>
        <TagInput
          id="nd-tags"
          tags={drawer.tags}
          onTagsChange={drawer.setTags}
          draft={drawer.tagDraft}
          onDraftChange={drawer.setTagDraft}
          vocabulary={drawer.tagVocabulary}
          disabled={!canEdit}
        />
      </div>
      {isBookmark && (
        <p className="field-hint">Icon changes apply immediately.</p>
      )}
      {isBookmark && (
        <FaviconDropCard
          inputId="nd-favicon"
          labelId="nd-favicon-label"
          currentIconUrl={faviconUrl}
          disabled={!canEdit || drawer.faviconBusy}
          onPick={(file) => void drawer.uploadFavicon(file)}
          onRemove={() => void drawer.removeFavicon()}
        />
      )}
      {isBookmark && snap && (
        <FaviconSourceControl
          collectionId={snap.collection.id}
          nodeId={node.id}
          disabled={!canEdit || drawer.faviconBusy}
          /* Same contract the inspector kept: an upload/delete through the
             drop card above updates iconUrl — bumping this key refetches the
             source instead of showing stale radios. */
          refreshKey={node.iconUrl ?? null}
        />
      )}
      {isBookmark && snap && canEdit && (
        <PreviewModeControl
          key={node.id}
          collectionId={snap.collection.id}
          nodeId={node.id}
          disabled={!canEdit}
          onChanged={() => loadTree(snap.collection.id, { silent: true })}
        />
      )}
      <NodeAnnotationFields
        idPrefix="nd"
        disabled={!canEdit}
        tldr={drawer.tldrDraft}
        note={drawer.annotation.draft}
        tldrVisibility={drawer.tldrVisibility}
        noteVisibility={drawer.noteVisibility}
        onTldrChange={drawer.setTldrDraft}
        onNoteChange={drawer.annotation.setDraft}
        onTldrVisibilityChange={drawer.setTldrVisibility}
        onNoteVisibilityChange={drawer.setNoteVisibility}
      />
    </div>
    <footer className="node-drawer-foot">
      <span className="node-drawer-status" role="status" data-testid="node-drawer-status">{drawer.status}</span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={!canEdit || !dirty || drawer.saving}
        onClick={() => void drawer.save()}
      >
        Save
      </button>
    </footer>
    </Modal>
  )
}
