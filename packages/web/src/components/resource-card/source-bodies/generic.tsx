import { ExternalLink } from '../../ExternalLink'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

/** Fallback body for unregistered / unknown source types. Never throws. */
export function GenericBody({ resource }: SourceBodyProps) {
  return (
    <>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full" data-testid="summary">
        {resource.summary}
      </p>
      <CardMeta>
        <span>{resource.host}</span>
        {resource.meta?.read && <span>{resource.meta.read}</span>}
        {resource.meta?.date && <span>{resource.meta.date}</span>}
      </CardMeta>
    </>
  )
}
