import type { GovernanceTarget } from '@known/product-v1-client'
import { humanLabel, MODERATION_TARGET_LABEL } from './moderationLabels'

export function formatGovernanceTarget(target: GovernanceTarget): string {
  return `${humanLabel(MODERATION_TARGET_LABEL, target.kind)} ${target.id}`
}

export function governanceTargetHref(target: GovernanceTarget): string | null {
  if (target.kind === 'collection') return `/library/${target.id}`
  if (target.kind === 'bookmark') return `/r/${target.id}`
  if (target.kind === 'comment') return `/community/comments/${target.id}`
  return null
}

/** Row title for a governance target: the kind ("Collection", "Bookmark",
    "Account"). Opaque ids never become a title. */
export function governanceTargetKind(target: GovernanceTarget): string {
  return humanLabel(MODERATION_TARGET_LABEL, target.kind)
}

/** Opaque ids read as a short reference in row meta. */
export function shortGovernanceId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id
}

/** Meta line under a target title: short id plus its parent locator. */
export function governanceTargetMeta(target: GovernanceTarget): string {
  const parent = target.kind === 'bookmark' ? ` · in collection ${shortGovernanceId(target.collectionId)}`
    : target.kind === 'digest_edition' ? ` · in digest ${shortGovernanceId(target.seriesId)}`
      : ''
  return `${shortGovernanceId(target.id)}${parent}`
}
