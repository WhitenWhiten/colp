import type { PublicCollectionSnapshot } from '../api'
import {
  comparePublicSiblings,
  hostForUrl,
  safeExternalUrl,
  type PublicCollectionResource,
} from './publicCollectionTree'

/** One entry block of a digest issue: a source-Collection folder rendered as
    an editorial section. `depth` 0 is a top-level section; deeper folders
    become nested subsections. */
export type ReportIssueSection = {
  readonly id: string
  readonly title: string
  readonly depth: number
  readonly resources: PublicCollectionResource[]
}

export type ReportIssueContents = {
  /** Top-level bookmarks that sit outside any folder. */
  readonly lead: PublicCollectionResource[]
  /** Folder sections in document order, empty subtrees dropped. */
  readonly sections: ReportIssueSection[]
}

/** Sections a reader can jump to — the top-level folders only. */
export function reportSectionLinks(contents: ReportIssueContents): ReportIssueSection[] {
  return contents.sections.filter((section) => section.depth === 0)
}

/**
 * Fold a live source-Collection snapshot into the issue's editorial outline:
 * folders become section headings in tree order, bookmarks join the section
 * of their enclosing folder (or the unsectioned lead). A folder is only
 * emitted once a descendant bookmark exists, so empty subtrees never render
 * bare headings.
 */
export function reportIssueSections(
  snapshot: PublicCollectionSnapshot,
): ReportIssueContents | null {
  const root = snapshot.nodes.find(
    (node) => node.id === snapshot.collection.rootNodeId && node.kind === 'root',
  )
  if (!root) return null

  const childrenByParent = new Map<string, typeof snapshot.nodes>()
  for (const node of snapshot.nodes) {
    if (node.id === root.id || node.parentId === null) continue
    const siblings = childrenByParent.get(node.parentId) ?? []
    siblings.push(node)
    childrenByParent.set(node.parentId, siblings)
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(comparePublicSiblings)
  }

  const lead: PublicCollectionResource[] = []
  const sections: ReportIssueSection[] = []
  /* Folder headings entered but not yet emitted — flushed when the first
     descendant bookmark lands, so empty folders leave no stray headings. */
  const pending: ReportIssueSection[] = []

  const visit = (
    parentId: string,
    depth: number,
    path: string[],
    pathIds: string[],
    current: ReportIssueSection | null,
    lineage: ReadonlySet<string>,
  ) => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (lineage.has(node.id)) continue
      const nextLineage = new Set(lineage)
      nextLineage.add(node.id)
      if (node.kind === 'folder') {
        const section: ReportIssueSection = {
          id: node.id, title: node.title, depth, resources: [],
        }
        pending.push(section)
        visit(node.id, depth + 1, [...path, node.title], [...pathIds, node.id], section, nextLineage)
        const pendingIndex = pending.indexOf(section)
        if (pendingIndex !== -1) pending.splice(pendingIndex, 1)
      } else if (node.kind === 'bookmark') {
        while (pending.length > 0) sections.push(pending.shift()!)
        ;(current?.resources ?? lead).push({
          node,
          depth,
          path,
          pathIds,
          href: safeExternalUrl(node.url),
          host: hostForUrl(node.url),
        })
      }
    }
  }
  visit(root.id, 0, [], [], null, new Set([root.id]))

  return { lead, sections }
}
