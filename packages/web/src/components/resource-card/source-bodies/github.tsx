import { ExternalLink } from '../../ExternalLink'
import { Icon } from '../../Icon'
import { CardMeta } from '../CardMeta'
import type { SourceBodyProps } from './types'

export function GithubBody({ resource }: SourceBodyProps) {
  return (
    <>
      <div className="repo-name" data-testid="repo-name">
        <span>{resource.meta?.owner} /</span>
        <br />
        <ExternalLink href={resource.url}>
          {resource.title}
        </ExternalLink>
      </div>
      <p className="summary" data-testid="summary">{resource.summary}</p>
      <CardMeta>
        <span><Icon name="star" /> {resource.meta?.stars}</span>
        {resource.meta?.forks != null && <span><Icon name="fork" /> {resource.meta.forks}</span>}
        {resource.meta?.lang && (
          <span
            className="language"
            style={{
              ['--lang-color' as string]: String(resource.meta.langColor ?? '#888'),
            }}
          >
            {resource.meta.lang}
          </span>
        )}
        <span className="standard-only">MIT</span>
      </CardMeta>
      {resource.meta?.commit && (
        <div className="commit tall-only" data-testid="commit">
          <div className="commit-row">
            <span>Latest commit</span>
            <span>{resource.meta.commitAge}</span>
          </div>
          <div className="commit-row">
            <span>{resource.meta.commit}</span>
            <span>{resource.meta.commitHash}</span>
          </div>
        </div>
      )}
    </>
  )
}
