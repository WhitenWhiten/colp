import { useToast } from '../components/AppToast'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useSyncCenterData } from './sync/data'
import { useSyncCenterMutations } from './sync/mutations'
import { useTrashBatchMutations } from './sync/trash-batch'
import { SyncView } from './sync/view'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/sync.css'

export function Sync() {
  const { success } = useToast()
  // The route module must own the tab title (route-document-title contract);
  // the view's PageHead repeats the same static title once rendered.
  useDocumentTitle('Sync')

  const data = useSyncCenterData()
  const mutations = useSyncCenterMutations({
    mounted: data.mounted,
    drafts: data.drafts,
    setDraft: data.setDraft,
    refreshConflict: data.refreshConflict,
    load: data.load,
    loadTrash: data.loadTrash,
    trashCollectionId: data.trashCollectionId,
    setStatus: data.setStatus,
    setConflicts: data.setConflicts,
    setDrafts: data.setDrafts,
    restoreConflictFocus: data.restoreConflictFocus,
    success,
  })

  const trashBatch = useTrashBatchMutations({
    mounted: data.mounted,
    items: data.trashItems,
    collectionId: data.trashCollectionId,
    loadTrash: data.loadTrash,
  })

  return <SyncView data={data} mutations={mutations} trashBatch={trashBatch} />
}
