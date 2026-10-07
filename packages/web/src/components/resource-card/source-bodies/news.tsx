import { sourceLabel } from '../../../lib/sources'
import { ExternalLink } from '../../ExternalLink'
import { Icon } from '../../Icon'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

/** Shared body for techcrunch / theverge / nytimes / reuters / kr36 / sspai / infoq / smashing. */
export function NewsBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="news-kicker">
        {resource.meta?.section ??
          resource.meta?.channel ??
          resource.meta?.topic ??
          sourceLabel[resource.type]}
      </p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        {resource.meta?.time != null && <span>{resource.meta.time}</span>}
        {resource.meta?.date != null && <span>{resource.meta.date}</span>}
        {resource.meta?.byline != null && <span>{resource.meta.byline}</span>}
        {resource.meta?.author != null && <span>{resource.meta.author}</span>}
        {resource.meta?.read != null && <span>{resource.meta.read}</span>}
        {resource.meta?.likes != null && <span><Icon name="heart" /> {resource.meta.likes}</span>}
        {resource.meta?.level != null && <span>{resource.meta.level}</span>}
      </CardMeta>
    </>
  )
}
