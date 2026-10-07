import type { PublicCollectionSnapshot } from '../../api'
import { flattenPublicCollection, type PublicCollectionResource } from '../../lib/publicCollectionTree'
import { resourceKindLabel } from '../../lib/resourceKind'

export function graphResources(snapshot: PublicCollectionSnapshot | null, includeRoot = false): PublicCollectionResource[] {
  if (!snapshot) return []
  const tree = flattenPublicCollection(snapshot)
  if (!tree) return []
  const rootHasRelations = snapshot.relations?.some((edge) => edge.fromNodeId === tree.root.id || edge.toNodeId === tree.root.id)
  const containers = [...(rootHasRelations || includeRoot ? [{ node: tree.root, depth: 0 }] : []), ...tree.folders]
  return [
    ...tree.resources.filter((resource) => resource.node.state !== 'hidden'),
    ...containers
      .filter(({ node }) => node.state !== 'hidden')
      .map(({ node, depth }) => ({ node, depth, path: [], pathIds: [], href: null, host: '' })),
  ]
}

export function graphResourceKind(resource: PublicCollectionResource): string {
  if (resource.node.kind === 'root') return 'Collection'
  if (resource.node.kind === 'folder') return 'Folder'
  return resourceKindLabel(resource.host)
}
