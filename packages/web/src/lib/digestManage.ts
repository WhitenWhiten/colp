import type { StatusTone } from '../components/StatusBadge'
import type { ReportEdition, ReportSeries, ReportSeriesCreate } from '../api'

/** Shared vocabulary for the curator-management surfaces (R10-05/36): the
    same visibility/state words on the Mine board, the manage head and the
    settings form — one map, no drift. */

export type DigestVisibility = NonNullable<ReportSeriesCreate['visibility']>

export const DIGEST_VISIBILITIES: { value: DigestVisibility; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'Only you and collaborators can open it.' },
  { value: 'protected', label: 'Protected', hint: 'Only you and collaborators can open it for now.' },
  { value: 'unlisted', label: 'Unlisted', hint: "Anyone with the link can open it. It isn't listed in the directory." },
  { value: 'public', label: 'Public', hint: 'Listed in the digest directory. Anyone can open and follow it.' },
]

const VISIBILITY_TONE: Record<string, StatusTone> = {
  public: 'success',
  unlisted: 'warning',
  protected: 'accent',
  private: 'muted',
}

export function digestVisibilityTone(series: Pick<ReportSeries, 'visibility' | 'state'>): StatusTone {
  if (series.state === 'archived') return 'neutral'
  return VISIBILITY_TONE[series.visibility] ?? 'neutral'
}

export function digestVisibilityLabel(series: Pick<ReportSeries, 'visibility' | 'state'>): string {
  if (series.state === 'archived') return 'Archived'
  return DIGEST_VISIBILITIES.find((v) => v.value === series.visibility)?.label ?? series.visibility
}

export const ISSUE_STATE_TONE: Record<ReportEdition['state'], StatusTone> = {
  draft: 'muted',
  published: 'success',
  withdrawn: 'warning',
  detached: 'neutral',
}

export const ISSUE_STATE_LABEL: Record<ReportEdition['state'], string> = {
  draft: 'Draft',
  published: 'Published',
  withdrawn: 'Withdrawn',
  detached: 'Detached',
}
