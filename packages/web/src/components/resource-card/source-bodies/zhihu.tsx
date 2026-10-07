import { ExternalLink } from '../../ExternalLink'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

export function ZhihuBody({ resource }: SourceBodyProps) {
  return (
    <>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.answers}</span>
        <span>{resource.meta?.followers}</span>
      </CardMeta>
      {resource.meta?.author && (
        <div className="answer wide-only">
          <div className="answer-author">
            <span className="answer-avatar">林</span>
            <span>{resource.meta.author}</span>
          </div>
          <p className="summary summary--full">
            “{resource.meta.quote}”
          </p>
        </div>
      )}
    </>
  )
}
