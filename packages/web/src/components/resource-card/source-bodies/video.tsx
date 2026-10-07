import { CoverImage } from '../../CoverFallback'
import { ExternalLink } from '../../ExternalLink'
import { Icon } from '../../Icon'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

/** Shared body for youtube / bilibili / vimeo / ted. */
export function VideoBody({ resource }: SourceBodyProps) {
  return (
    <div className="video-layout" data-testid="video-layout">
      <div className="video-media" data-testid="video-media">
        <CoverImage className="video-fallback" src={resource.image} title={resource.title} />
        <ExternalLink
          className="play"
          href={resource.url}
          aria-label={`Play ${resource.title}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="play" />
        </ExternalLink>
        <span className="duration" data-testid="duration">{resource.meta?.duration}</span>
      </div>
      <div className="video-copy">
        <h2 className="card-title">
          <ExternalLink href={resource.url}>
            {resource.title}
          </ExternalLink>
        </h2>
        <p className="summary">{resource.summary}</p>
        <CardMeta>
          <span>{resource.meta?.views}</span>
          {resource.meta?.likes != null && <span><Icon name="heart" /> {resource.meta.likes}</span>}
          {resource.meta?.age && <span>{resource.meta.age}</span>}
          {resource.meta?.danmaku && <span><Icon name="chat" /> {resource.meta.danmaku}</span>}
          {resource.meta?.event && <span>{resource.meta.event}</span>}
          {resource.meta?.staff && <span>{resource.meta.staff}</span>}
          <span className="wide-only">
            {resource.meta?.up ?? (resource.type === 'ted' ? 'TED Talk' : 'Captions')}
          </span>
        </CardMeta>
      </div>
    </div>
  )
}
