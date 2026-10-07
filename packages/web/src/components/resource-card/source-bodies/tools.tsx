import { ExternalLink } from '../../ExternalLink'
import { Icon } from '../../Icon'
import { CardMeta } from '../CardMeta'
import { metaString } from './meta'
import type { SourceBodyProps } from './types'

export function PathBody({ resource }: SourceBodyProps) {
  const steps = (metaString(resource, 'steps') ?? '')
    .split('→')
    .map((s) => s.trim())
    .filter(Boolean)
  return (
    <>
      <h2 className="card-title">{resource.title}</h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <ol className="path-steps">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </>
  )
}

export function FigmaBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="figma-preview standard-only" aria-hidden>
        <span className="figma-frame one" />
        <span className="figma-frame two" />
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.duplicates} duplicates</span>
        <span>{resource.meta?.likes} likes</span>
      </CardMeta>
    </>
  )
}

export function ProductHuntBody({ resource }: SourceBodyProps) {
  return (
    <>
      <h2 className="card-title card-title--fill">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <div className="upvote" aria-label={`${resource.meta?.upvotes ?? 0} upvotes`}><Icon name="arrow-up" /> {resource.meta?.upvotes}</div>
      <CardMeta>
        <span>{resource.meta?.rank}</span>
        <span>{resource.meta?.comments} comments</span>
      </CardMeta>
    </>
  )
}

export function StackOverflowBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="so-stats">
        <span className="so-stat">
          <strong>{resource.meta?.votes}</strong>
          votes
        </span>
        <span className={`so-stat ${resource.meta?.accepted === 'yes' ? 'is-accepted' : ''}`}>
          <strong>{resource.meta?.answers}</strong>
          answers
        </span>
        <span className="so-stat so-stat--muted">
          <strong>{resource.meta?.views}</strong>
          views
        </span>
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
    </>
  )
}

export function NpmBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="npm-version">{resource.meta?.version}</div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span><Icon name="download" /> {resource.meta?.weekly}/wk</span>
        <span>{resource.meta?.license}</span>
      </CardMeta>
    </>
  )
}

export function HuggingFaceBody({ resource }: SourceBodyProps) {
  return (
    <>
      <span className="hf-task">{resource.meta?.task}</span>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span><Icon name="download" /> {resource.meta?.downloads}</span>
        <span><Icon name="heart" /> {resource.meta?.likes}</span>
      </CardMeta>
    </>
  )
}

export function NotionBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="notion-icon" aria-hidden>
        <Icon name="file" />
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span>{resource.meta?.workspace}</span>
        <span>{resource.meta?.pages} pages</span>
        <span>{resource.meta?.updated}</span>
      </CardMeta>
    </>
  )
}

export function CodepenBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="codepen-preview" aria-hidden>
        <span /><span /><span />
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.author}</span>
        <span><Icon name="heart" /> {resource.meta?.hearts}</span>
        <span><Icon name="chat" /> {resource.meta?.comments}</span>
      </CardMeta>
    </>
  )
}

export function ArenaBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="arena-grid" aria-hidden>
        <i /><i /><i /><i />
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.blocks} blocks</span>
        <span>{resource.meta?.connections} connections</span>
      </CardMeta>
    </>
  )
}

export function CourseraBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="course-rating">
        <strong>{resource.meta?.rating}</strong>
        <span><Icon name="star" /> · {resource.meta?.learners} learners</span>
      </div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.level}</span>
      </CardMeta>
    </>
  )
}
