import type { StatusTone } from '../components/StatusBadge'

/* Human labels for the governance enums in product-v1.yaml (report
   categories, case statuses and target kinds). Unknown values fall back to
   the raw value with underscores as spaces, so a new server enum still
   reads as words. */
export const MODERATION_CATEGORY_LABEL: Record<string, string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  illegal_content: 'Illegal content',
  privacy: 'Privacy',
  other: 'Other',
}

export const MODERATION_STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  in_review: 'In review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

export const MODERATION_STATUS_TONE: Record<string, StatusTone> = {
  submitted: 'neutral',
  in_review: 'accent',
  resolved: 'success',
  dismissed: 'muted',
}

export const MODERATION_ACTION_LABEL: Record<string, string> = {
  delist: 'Removed from listings',
  hide_public: 'Hidden from the public',
  restrict_interaction: 'Interactions limited',
  restrict_publication: 'Publishing limited',
  hide_comment: 'Comment hidden',
  lock_comments: 'Comments locked',
}

export const MODERATION_APPEAL_STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  upheld: 'Upheld',
  rejected: 'Rejected',
}

export const MODERATION_APPEAL_STATUS_TONE: Record<string, StatusTone> = {
  submitted: 'neutral',
  upheld: 'success',
  rejected: 'muted',
}

export const MODERATION_ACTION_STATE_LABEL: Record<string, string> = {
  active: 'Active',
  revoked: 'Revoked',
}

export const MODERATION_TARGET_LABEL: Record<string, string> = {
  collection: 'Collection',
  bookmark: 'Bookmark',
  digest_series: 'Digest',
  digest_edition: 'Digest issue',
  account: 'Account',
  comment: 'Comment',
}

export const humanLabel = (map: Record<string, string>, value: string) => map[value] ?? value.replace(/_/g, ' ')
