import { CoverImage } from '../../CoverFallback'
import { ExternalLink } from '../../ExternalLink'
import { Icon } from '../../Icon'
import { CardMeta } from '../CardMeta'
import { metaString } from './meta'
import type { SourceBodyProps } from './types'

export function XBody({ resource }: SourceBodyProps) {
  const handle = metaString(resource, 'handle') ?? '@'
  return (
    <>
      <div className="x-handle">
        <span className="x-avatar" aria-hidden>
          {handle.slice(1, 2).toUpperCase()}
        </span>
        <div>
          <strong>{resource.meta?.handle}</strong>
          <span className="meta"> · {resource.meta?.time}</span>
        </div>
      </div>
      <h2 className="card-title x-body">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span aria-label={`${resource.meta?.likes ?? 0} likes`}><Icon name="heart-open" /> {resource.meta?.likes}</span>
        <span aria-label={`${resource.meta?.reposts ?? 0} reposts`}><Icon name="sync" /> {resource.meta?.reposts}</span>
      </CardMeta>
    </>
  )
}

export function RedditBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="reddit-sub">{resource.meta?.subreddit}</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span aria-label={`${resource.meta?.upvotes ?? 0} upvotes`}><Icon name="arrow-up" /> {resource.meta?.upvotes}</span>
        <span><Icon name="chat" /> {resource.meta?.comments}</span>
      </CardMeta>
    </>
  )
}

export function HackerNewsBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="hn-rank">{resource.meta?.rank}</div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.points} points</span>
        <span>{resource.meta?.comments} comments</span>
      </CardMeta>
    </>
  )
}

export function BlueskyBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="x-handle">
        <span className="bluesky-avatar" aria-hidden>
          <Icon name="sparkle" />
        </span>
        <strong>{resource.meta?.handle}</strong>
      </div>
      <h2 className="card-title x-body">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span aria-label={`${resource.meta?.likes ?? 0} likes`}><Icon name="heart-open" /> {resource.meta?.likes}</span>
        <span aria-label={`${resource.meta?.reposts ?? 0} reposts`}><Icon name="sync" /> {resource.meta?.reposts}</span>
      </CardMeta>
    </>
  )
}

export function LobstersBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="lobsters-score">{resource.meta?.score}</div>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.comments} comments</span>
        <span>{resource.meta?.tags}</span>
      </CardMeta>
    </>
  )
}

export function XiaohongshuBody({ resource }: SourceBodyProps) {
  return (
    <div className="xhs-layout">
      {resource.image ? (
        <div className="xhs-media">
          <CoverImage src={resource.image} title={resource.title} />
        </div>
      ) : null}
      <div className="xhs-copy">
        <h2 className="card-title">
          <ExternalLink href={resource.url}>
            {resource.title}
          </ExternalLink>
        </h2>
        <p className="summary summary--full">
          {resource.summary}
        </p>
        <CardMeta>
          <span>{resource.meta?.author}</span>
          <span><Icon name="heart" /> {resource.meta?.likes}</span>
          <span><Icon name="star-open" /> {resource.meta?.collects}</span>
        </CardMeta>
      </div>
    </div>
  )
}

export function WechatBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="wechat-account">{resource.meta?.account}</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span>{resource.meta?.date}</span>
        <span>{resource.meta?.read}</span>
      </CardMeta>
    </>
  )
}

export function LessWrongBody({ resource }: SourceBodyProps) {
  return (
    <>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span>Karma {resource.meta?.karma}</span>
        <span>{resource.meta?.comments} comments</span>
      </CardMeta>
    </>
  )
}

export function MediumBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="medium-kicker">{resource.meta?.author}</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span>{resource.meta?.read}</span>
        <span>{resource.meta?.claps} claps</span>
      </CardMeta>
    </>
  )
}

export function SubstackBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="substack-kicker">Newsletter · {resource.meta?.issue}</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span>{resource.meta?.author}</span>
        <span>{resource.meta?.readers} readers</span>
      </CardMeta>
    </>
  )
}

export function DevtoBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="devto-author">@{resource.meta?.author}</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span><Icon name="heart" /> {resource.meta?.reactions}</span>
        <span><Icon name="chat" /> {resource.meta?.comments}</span>
      </CardMeta>
    </>
  )
}
