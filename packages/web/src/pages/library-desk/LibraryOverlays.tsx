import {
  CollectionDestinationPicker,
} from '../../components/CollectionDestinationPicker'
import type { ConfirmRequest } from '../../components/ConfirmModal'
import type { EditableNodeView, EditorSnapshot } from '../../api'
import type { useOwnedCollections } from '../../lib/useOwnedCollections'
import type { useSharedCollections } from '../../lib/useSharedCollections'
import type { LibraryDeskMutations } from './mutations'
import { plural } from '../../lib/plural'
import type { LibraryDeskSelection } from './selection'

/** Bookmarks and folders under the folders being deleted, not the folders themselves. */
function descendantCounts(folderIds: Set<string>, all: EditableNodeView[]) {
  const inside = new Set(folderIds)
  let changed = true
  while (changed) {
    changed = false
    for (const node of all) {
      if (node.parentId && inside.has(node.parentId) && !inside.has(node.id)) {
        inside.add(node.id)
        changed = true
      }
    }
  }
  let bookmarks = 0
  let folders = 0
  for (const node of all) {
    if (!inside.has(node.id) || folderIds.has(node.id)) continue
    if (node.kind === 'folder') folders += 1
    else if (node.kind === 'bookmark') bookmarks += 1
  }
  return { bookmarks, folders }
}

/** Copy for the shared useConfirm() prompt. A folder delete names what is
    removed and that it can't be undone. Bookmark-only deletes stay as they are. */
export function libraryDeleteRequest(
  nodes: EditableNodeView[],
  all: EditableNodeView[] = [],
): ConfirmRequest {
  const confirmKind = nodes.every((node) => node.kind === 'folder')
    ? 'folder'
    : nodes.some((node) => node.kind === 'folder') ? 'item' : 'bookmark'
  const first = nodes[0]
  const multi = nodes.length > 1
  const title = multi
    ? `Delete ${plural(nodes.length, confirmKind)}`
    : confirmKind === 'folder' ? 'Delete folder' : 'Delete bookmark'
  if (!nodes.some((node) => node.kind === 'folder')) {
    return {
      title,
      body: multi ? (
        `Delete ${plural(nodes.length, confirmKind)}?`
      ) : first ? (
        <>
          Delete “
          <span className="library-delete-title" title={first.title}>
            {first.title}
          </span>
          ”?
        </>
      ) : (
        'Delete this bookmark?'
      ),
    }
  }
  const folderIds = new Set(nodes.flatMap((node) => (node.kind === 'folder' ? [node.id] : [])))
  const { bookmarks, folders } = descendantCounts(folderIds, all)
  const counted = [
    bookmarks > 0 && plural(bookmarks, 'bookmark'),
    folders > 0 && plural(folders, 'folder'),
  ].filter(Boolean).join(' and ')
  // Nothing inside: say so as its own sentence, in the grammar of what was
  // picked (one folder, several folders, or folders among bookmarks).
  const emptyNote = !multi
    ? "It's empty."
    : confirmKind === 'folder' ? "They're empty." : 'The selected folders are empty.'
  return {
    title,
    confirmLabel: confirmKind === 'folder' ? 'Delete folder' : 'Delete',
    body: multi ? (
      counted
        ? `Delete ${plural(nodes.length, confirmKind)}, including ${counted} inside them. This can't be undone.`
        : `Delete ${plural(nodes.length, confirmKind)}. ${emptyNote} This can't be undone.`
    ) : first ? (
      <>
        Delete “
        <span className="library-delete-title" title={first.title}>
          {first.title}
        </span>
        {counted
          ? `” and everything in it: ${counted}. This can't be undone.`
          : `”. ${emptyNote} This can't be undone.`}
      </>
    ) : (
      `${emptyNote} This can't be undone.`
    ),
  }
}

export function LibraryOverlays({
  collections,
  shared,
  snap,
  selection,
  mutations,
}: {
  collections: ReturnType<typeof useOwnedCollections>
  shared: ReturnType<typeof useSharedCollections>
  snap: EditorSnapshot | null
  selection: LibraryDeskSelection
  mutations: LibraryDeskMutations
}) {
  const { picker, setPicker, bulk } = selection
  const { runMove, runCopy } = mutations

  return (
    <>
      {picker && snap && (
        <CollectionDestinationPicker
          mode={picker.mode}
          count={picker.nodes.length}
          noun={picker.nodes.every((n) => n.kind === 'folder') ? 'folder' : picker.nodes.some((n) => n.kind === 'folder') ? 'item' : 'bookmark'}
          busy={bulk !== null}
          currentParentId={
            // Move mode flags the bookmarks' shared parent as "(current)";
            // a mixed multi-selection has no single current place.
            picker.mode === 'move'
              && new Set(picker.nodes.map((node) => node.parentId)).size === 1
              ? picker.nodes[0]?.parentId ?? null
              : null
          }
          movingIds={picker.mode === 'move' ? picker.nodes.map((node) => node.id) : undefined}
          current={{
            collection: { id: snap.collection.id, title: snap.collection.title },
            rootId: snap.root.id,
            nodes: snap.nodes,
          }}
          owned={collections.items}
          shared={shared.items}
          onPick={(destination) => {
            const { mode, nodes } = picker
            setPicker(null)
            if (mode === 'move') void runMove(nodes, destination)
            else void runCopy(nodes, destination)
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}
