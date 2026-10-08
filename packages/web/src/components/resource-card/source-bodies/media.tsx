import { CoverImage } from '../../CoverFallback'
import { ExternalLink } from '../../ExternalLink'
import { Icon } from '../../Icon'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

export function DoubanBody({ resource }: SourceBodyProps) {
  return (
    <div className="book-layout">
      <CoverImage className="book-cover" src={resource.image} title={resource.title} />
      <div>
        <div className="score">
          <strong>{resource.meta?.rating}</strong>
          <span className="score-stars" aria-hidden="true">
            <Icon name="star" /><Icon name="star" /><Icon name="star" />
            <Icon name="star" /><Icon name="star-open" />
          </span>
        </div>
        <h2 className="card-title">
          <ExternalLink href={resource.url}>
            {resource.title}
          </ExternalLink>
        </h2>
        <p className="summary">{resource.summary}</p>
        <CardMeta>
          <span>{resource.meta?.ratings}</span>
          <span>{resource.meta?.year}</span>
        </CardMeta>
      </div>
    </div>
  )
}

export function SpotifyBody({ resource }: SourceBodyProps) {
  return (
    <div className="audio-layout">
      <CoverImage className="album-cover" src={resource.image} title={resource.title} />
      <div>
        <h2 className="card-title">
          <ExternalLink href={resource.url}>
            {resource.title}
          </ExternalLink>
        </h2>
        <CardMeta>
          <span>{resource.meta?.duration}</span>
          <span>{resource.meta?.episode}</span>
        </CardMeta>
        <div className="progress standard-only" aria-hidden>
          <span style={{ width: String(resource.meta?.progress ?? '30%') }} />
        </div>
        <p className="summary tall-only">{resource.summary}</p>
      </div>
    </div>
  )
}

export function DribbbleBody({ resource }: SourceBodyProps) {
  return (
    <div className="dribbble-layout">
      {resource.image && (
        <div className="dribbble-shot">
          <CoverImage src={resource.image} title={resource.title} />
        </div>
      )}
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <CardMeta>
        <span>{resource.meta?.author}</span>
        <span><Icon name="heart" /> {resource.meta?.likes}</span>
        <span><Icon name="eye" /> {resource.meta?.views}</span>
      </CardMeta>
    </div>
  )
}
