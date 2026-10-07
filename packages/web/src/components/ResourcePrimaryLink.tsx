import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  resourcePrimaryTarget,
  type ResourceWorkspaceQuery,
} from '../lib/useResourceNode'
import { UGC_REL } from '../lib/ugcRel'

type Props = {
  resourceId: string
  url?: string | null
  query: ResourceWorkspaceQuery
  className?: string
  title?: string
  children: ReactNode
}

/** Primary bookmark link whose destination follows the Reader release gate. */
export function ResourcePrimaryLink({ resourceId, url, query, className, title, children }: Props) {
  const target = resourcePrimaryTarget(resourceId, url, query)
  if (target.kind === 'external') {
    return (
      <a className={className} href={target.href} target="_blank" rel={UGC_REL} title={title}>
        {children}
      </a>
    )
  }
  return <Link className={className} to={target.to} title={title}>{children}</Link>
}
