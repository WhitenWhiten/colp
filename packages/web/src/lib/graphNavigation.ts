/** Construct local destinations from identifiers; never accept a return URL. */
export function graphPath(slug: string, nodeId: string): string {
  return `/graph/${encodeURIComponent(slug)}?${new URLSearchParams({ node: nodeId })}`
}

export function graphRelationWorkspacePath(collectionId: string, slug: string, nodeId: string): string {
  return `/r/${encodeURIComponent(nodeId)}?${new URLSearchParams({ collectionId, subjectType: 'node', slug, fromGraph: '1' })}#resource-relations-heading`
}
