import { useMemo } from 'react'
import { AnnotationText } from '../annotation-markdown'
import { EmptyState } from '../EmptyState'
import { memberNodeReference, safeMemberHref, type MemberDigestAnnotation, type MemberDigestIssue } from '../../api/memberDigestClient'
function Annotations({ items }: { items: MemberDigestAnnotation[] }) {
  return <>{items.map(item => <div className={`digest-entry-note digest-entry-note--${item.type === 'tldr' ? 'tldr' : 'note'}`} key={item.id}>
    <span className="digest-entry-note-label">{item.type === 'tldr' ? 'TL;DR' : item.type === 'note' ? 'Note' : item.type}</span>{' '}
    <AnnotationText value={typeof item.value === 'string' ? item.value : JSON.stringify(item.value)} format={item.format ?? 'plain'} className="annotation-document" headingOffset={3} />
  </div>)}</>
}
/** Uses the current actor's single authorized response; no public cache/analytics. */
export function MemberDigestContent({ issue }: { issue: MemberDigestIssue }) {
  const content = issue.nodes.filter(node => node.role === 'content')
  const { descriptions, annotations } = useMemo(() => {
    const descriptions = new Map(issue.reader?.notes.map(note => [note.key, note.description]) ?? [])
    const annotations = new Map<string, MemberDigestAnnotation[]>()
    for (const item of issue.reader?.annotations ?? []) { const key = item.subjectType + ':' + item.subjectId; const items = annotations.get(key) ?? []; items.push(item); annotations.set(key, items) }
    return { descriptions, annotations }
  }, [issue])
  return <>
    {issue.reader?.seriesSummary && <section aria-label="Series summary"><p>{issue.reader.seriesSummary}</p></section>}
    {issue.reader?.editionSummary && <section aria-label="Issue summary"><p>{issue.reader.editionSummary}</p></section>}
    {issue.reader?.sourceSummary && <section aria-label="Source summary"><p>{issue.reader.sourceSummary}</p></section>}
    <Annotations items={issue.reader?.annotations.filter(item => item.subjectType === 'collection') ?? []} />
    <div className="digest-entry-list" aria-label="Issue entries">{content.map(node => {
      const ref = memberNodeReference(node.key, issue.series.sourceId, issue.edition.editionId), href = safeMemberHref(node.url)
      return <article className="digest-entry" key={node.key}>
        {node.kind === 'folder' ? <h3>{node.title}</h3> : <div className="digest-entry-head"><a className="digest-entry-title" href={href ?? undefined} target="_blank" rel="noopener noreferrer">{node.title}</a>{href && <span className="digest-entry-host-name">{new URL(href).hostname}</span>}</div>}
        {descriptions.get(node.key) && <p className="digest-entry-desc">{descriptions.get(node.key)}</p>}
        <Annotations items={ref ? annotations.get('node:' + ref.nodeId) ?? [] : []} />
      </article>
    })}</div>
    {!content.length && <EmptyState title="No readable entries" description="This issue currently has no readable bookmark content." />}
  </>
}
