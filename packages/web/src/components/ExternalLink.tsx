import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { safeExternalUrl } from '../lib/publicCollectionTree'
import { UGC_REL } from '../lib/ugcRel'

type ExternalLinkProps = {
  href: string | null | undefined
  children: ReactNode
} & Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'target' | 'rel'>

/** Outbound http(s) link. Rejected URLs render as a span with no href. */
export function ExternalLink({ href, children, className, ...rest }: ExternalLinkProps) {
  const safe = safeExternalUrl(href ?? null)
  if (!safe) {
    return (
      <span
        className={className}
        aria-label={rest['aria-label']}
        title={rest.title}
        onPointerDown={rest.onPointerDown}
      >
        {children}
      </span>
    )
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel={UGC_REL}
      className={className}
      {...rest}
    >
      {children}
    </a>
  )
}
