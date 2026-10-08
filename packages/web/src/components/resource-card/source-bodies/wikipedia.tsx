import { ExternalLink } from '../../ExternalLink'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

export function WikipediaBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="wiki-mark" aria-hidden data-testid="wiki-mark">
        W
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary" data-testid="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.read}</span>
        <span>{resource.meta?.langs}</span>
      </CardMeta>
      {resource.meta?.index && (
        <div className="wiki-index wide-only" data-testid="wiki-index">{resource.meta.index}</div>
      )}
    </>
  )
}
