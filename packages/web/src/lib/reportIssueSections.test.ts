import { describe, expect, it } from 'vitest'
import type { PublicCollectionSnapshot } from '../api'
import { reportIssueSections, reportSectionLinks } from './reportIssueSections'

function node(id: string, parentId: string | null, kind: 'root' | 'folder' | 'bookmark', title: string, position = '0') {
  return {
    id,
    parentId,
    kind,
    title,
    description: null,
    url: kind === 'bookmark' ? `https://example.test/${id}` : null,
    position,
  }
}

function snapshot(nodes: ReturnType<typeof node>[]): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-1',
      slug: 'issue-sources',
      title: 'Issue sources',
      summary: null,
      kind: 'bookmarks',
      rootNodeId: 'root',
      updatedAt: '2026-09-01T00:00:00.000Z',
      access: 'public',
      owner: undefined,
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

describe('reportIssueSections', () => {
  it('returns null when the snapshot has no root node', () => {
    expect(reportIssueSections(snapshot([node('orphan', null, 'folder', 'F')]))).toBeNull()
  })

  it('lands root-level bookmarks in the lead and emits no sections without folders', () => {
    const contents = reportIssueSections(snapshot([
      node('root', null, 'root', 'Root'),
      node('a', 'root', 'bookmark', 'A'),
      node('b', 'root', 'bookmark', 'B'),
    ]))
    expect(contents?.lead.map((r) => r.node.id)).toEqual(['a', 'b'])
    expect(contents?.sections).toEqual([])
    expect(contents?.lead[0]?.href).toBe('https://example.test/a')
    expect(contents?.lead[0]?.host).toBe('example.test')
  })

  it('folds folders into ordered sections and keeps tree order', () => {
    const contents = reportIssueSections(snapshot([
      node('root', null, 'root', 'Root'),
      node('lead-1', 'root', 'bookmark', 'Lead'),
      node('f1', 'root', 'folder', 'Research'),
      node('f1-a', 'f1', 'bookmark', 'Paper'),
      node('f2', 'root', 'folder', 'Tools'),
      node('f2-a', 'f2', 'bookmark', 'CLI'),
      node('lead-2', 'root', 'bookmark', 'Tail'),
    ]))
    expect(contents?.lead.map((r) => r.node.id)).toEqual(['lead-1', 'lead-2'])
    expect(contents?.sections.map((s) => s.title)).toEqual(['Research', 'Tools'])
    expect(contents?.sections[0]?.resources.map((r) => r.node.id)).toEqual(['f1-a'])
    expect(contents?.sections[0]?.depth).toBe(0)
    expect(contents?.sections[0]?.resources[0]?.path).toEqual(['Research'])
  })

  it('keeps nested folders as deeper sections and flushes ancestors before descendants', () => {
    const contents = reportIssueSections(snapshot([
      node('root', null, 'root', 'Root'),
      node('f1', 'root', 'folder', 'Research'),
      node('f1-sub', 'f1', 'folder', 'Papers'),
      node('deep', 'f1-sub', 'bookmark', 'Deep'),
      node('own', 'f1', 'bookmark', 'Own'),
    ]))
    expect(contents?.sections.map((s) => [s.title, s.depth])).toEqual([
      ['Research', 0],
      ['Papers', 1],
    ])
    // The nested section holds its own bookmark; the parent's direct
    // bookmark lands on the parent section even though it sorts later.
    expect(contents?.sections[1]?.resources.map((r) => r.node.id)).toEqual(['deep'])
    expect(contents?.sections[0]?.resources.map((r) => r.node.id)).toEqual(['own'])
    expect(contents?.lead).toEqual([])
  })

  it('drops folders whose subtree has no visible bookmarks', () => {
    const contents = reportIssueSections(snapshot([
      node('root', null, 'root', 'Root'),
      node('empty', 'root', 'folder', 'Empty'),
      node('nested-empty', 'empty', 'folder', 'Nested empty'),
      node('a', 'root', 'bookmark', 'A'),
    ]))
    expect(contents?.sections).toEqual([])
    expect(contents?.lead.map((r) => r.node.id)).toEqual(['a'])
  })

  it('lists only top-level sections as jump links', () => {
    const contents = reportIssueSections(snapshot([
      node('root', null, 'root', 'Root'),
      node('f1', 'root', 'folder', 'Research'),
      node('f1-sub', 'f1', 'folder', 'Papers'),
      node('deep', 'f1-sub', 'bookmark', 'Deep'),
      node('f2', 'root', 'folder', 'Tools'),
      node('f2-a', 'f2', 'bookmark', 'CLI'),
    ]))
    expect(reportSectionLinks(contents!).map((s) => s.title)).toEqual(['Research', 'Tools'])
  })

  it('survives a node-id cycle in the tree without hanging', () => {
    /* Two nodes share id "f": root → f → g → f(again). The lineage guard
       stops the second visit, so the section closes after g's content. */
    const contents = reportIssueSections(snapshot([
      node('root', null, 'root', 'Root'),
      node('f', 'root', 'folder', 'Outer'),
      node('g', 'f', 'folder', 'Inner'),
      node('f', 'g', 'folder', 'Outer again'),
      node('inside', 'f', 'bookmark', 'Inside'),
      node('leaf', 'g', 'bookmark', 'Leaf'),
    ]))
    expect(contents).not.toBeNull()
    const titles = contents!.sections.map((s) => s.title)
    expect(titles).toContain('Outer')
    expect(titles).toContain('Inner')
  })
})
