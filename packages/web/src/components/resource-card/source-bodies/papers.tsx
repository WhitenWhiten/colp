import { ExternalLink } from '../../ExternalLink'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

export function ArxivBody({ resource }: SourceBodyProps) {
  return (
    <>
      <span className="paper-id">{resource.meta?.paperId}</span>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="authors">{resource.meta?.authors}</p>
      <p className="summary wide-only">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.subjects}</span>
        <span>{resource.meta?.pages}</span>
        <span className="standard-only">PDF</span>
      </CardMeta>
    </>
  )
}

export function NatureBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="nature-journal">{resource.meta?.journal}</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.type}</span>
        <span>{resource.meta?.year}</span>
      </CardMeta>
    </>
  )
}

/** Shared body for semanticscholar / scholar. */
export function ScholarBody({ resource }: SourceBodyProps) {
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
        {resource.meta?.citations != null && <span>Cited by {resource.meta.citations}</span>}
        {resource.meta?.influential != null && <span>{resource.meta.influential} influential</span>}
        {resource.meta?.results != null && <span>{resource.meta.results}</span>}
        {resource.meta?.year != null && <span>{resource.meta.year}</span>}
      </CardMeta>
    </>
  )
}

export function OpenReviewBody({ resource }: SourceBodyProps) {
  return (
    <>
      <span className="or-venue">{resource.meta?.venue}</span>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.decision}</span>
        <span>{resource.meta?.reviews} reviews</span>
      </CardMeta>
    </>
  )
}

export function PapersWithCodeBody({ resource }: SourceBodyProps) {
  return (
    <>
      <span className="pwc-sota">{resource.meta?.sota}</span>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.papers} papers</span>
        <span>{resource.meta?.code} code</span>
      </CardMeta>
    </>
  )
}

export function DistillBody({ resource }: SourceBodyProps) {
  return (
    <>
      <p className="distill-kicker">Interactive essay</p>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary summary--full">
        {resource.summary}
      </p>
      <CardMeta>
        <span>{resource.meta?.authors}</span>
        <span>{resource.meta?.year}</span>
      </CardMeta>
    </>
  )
}

export function AcmBody({ resource }: SourceBodyProps) {
  return (
    <>
      <span className="paper-id">{resource.meta?.doi}</span>
      <h2 className="card-title">
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </h2>
      <p className="summary">{resource.summary}</p>
      <CardMeta>
        <span>{resource.meta?.venue}</span>
        <span>{resource.meta?.pages} pp.</span>
      </CardMeta>
    </>
  )
}
