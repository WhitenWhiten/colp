import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  isReportsExposureEnabled,
  productClient,
  type OwnedCollectionListItem,
  type ReportEdition,
  type ReportEditionAttach,
  type ReportEditionPatch,
  type ReportMemberMutation,
  type ReportScheduleInput,
  type ReportSeries,
  type ReportSeriesPatch,
} from '../api'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { Breadcrumb } from '../components/Breadcrumb'
import { CollectionDestinationPicker } from '../components/CollectionDestinationPicker'
import { useConfirm, useConfirmLeaveGuard } from '../components/ConfirmModal'
import { DataTable, DataTableCell, DataTableRow } from '../components/DataTable'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { Modal } from '../components/Modal'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RolePick, type InviteRoleLabel } from '../components/RolePick'
import { RouteState } from '../components/RouteState'
import { StatusBadge } from '../components/StatusBadge'
import { TabList } from '../components/TabList'
import { canonicalSiteOrigin } from '../lib/chrome'
import { copyTextToClipboard } from '../lib/clipboard'
import { formatCalendarDate, formatDateTime } from '../lib/formatDate'
import {
  DIGEST_VISIBILITIES,
  ISSUE_STATE_LABEL,
  ISSUE_STATE_TONE,
  digestVisibilityLabel,
  digestVisibilityTone,
  type DigestVisibility,
} from '../lib/digestManage'
import { isAbort } from '../lib/libraryTree'
import { plural } from '../lib/plural'
import { reportIssuePath, reportSeriesPath } from '../lib/reports'
import { notifyMyReportsChanged } from '../lib/useMyReports'
import { useReportManage, type ReportManageOp } from '../lib/useReportManage'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { CatalogFields, type CatalogCommit } from './collection-editor/CatalogFields'
import { RowActionMenu } from './library-desk/menus'
import { onMenuLinkKeyDown } from '../lib/menuKeys'
import '../styles/collab.css'
import '../styles/not-found.css'
import '../styles/digest-manage.css'
import '../styles/library.css'

const toInviteRole = (role: 'editor' | 'viewer'): InviteRoleLabel =>
  role === 'editor' ? 'Editor' : 'Viewer'
const toMemberRole = (role: InviteRoleLabel): ReportMemberMutation['role'] =>
  role === 'Editor' ? 'editor' : 'viewer'

type ManageTab = 'issues' | 'settings' | 'collaborators'

/* Literal class names — the dead-class gate cannot see `is-${op}` stems. */
const OP_BAR_CLASS: Partial<Record<ReportManageOp, string>> = {
  unknown: 'is-unknown',
  stale: 'is-stale',
  conflict: 'is-conflict',
  error: 'is-error',
}

const toDateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const fromDateInput = (value: string) => (value ? `${value}T00:00:00.000Z` : null)

const SCHEDULE_FREQS = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
] as const
type ScheduleFreq = (typeof SCHEDULE_FREQS)[number]['value']

const freqOf = (rrule: string): ScheduleFreq | null => {
  const match = /FREQ=(DAILY|WEEKLY|MONTHLY)/.exec(rrule)
  return (match?.[1] as ScheduleFreq | undefined) ?? null
}
const freqLabel = (freq: ScheduleFreq | null) =>
  SCHEDULE_FREQS.find((option) => option.value === freq)?.label ?? 'Scheduled'

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const periodLabel = (edition: ReportEdition) =>
  edition.periodStart && edition.periodEnd
    ? `${formatCalendarDate(edition.periodStart)} – ${formatCalendarDate(edition.periodEnd)}`
    : '—'

/** ISO-8601 week stamp (YYYY-Www) for a local calendar day. */
function isoWeekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

type AttachIssueField = 'collection' | 'title' | 'key' | 'period'

/** Attach a source collection as a new draft issue. */
function AttachIssueModal({ busy, onClose, onAttach }: {
  busy: boolean
  onClose: () => void
  onAttach: (body: ReportEditionAttach) => void
}) {
  const [collections, setCollections] = useState<OwnedCollectionListItem[] | null>(null)
  const [collectionsError, setCollectionsError] = useState(false)
  const [collectionId, setCollectionId] = useState('')
  const [issueKey, setIssueKey] = useState(() => isoWeekKey())
  const [keyEdited, setKeyEdited] = useState(false)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [errors, setErrors] = useState<Partial<Record<AttachIssueField, string>>>({})
  const [picking, setPicking] = useState(false)
  const setFieldError = (field: keyof typeof errors, message: string) =>
    setErrors((current) => ({ ...current, [field]: message }))
  const clearFieldError = (field: keyof typeof errors) =>
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))

  useEffect(() => {
    const controller = new AbortController()
    productClient.loadOwnedCollections({ limit: 100 }, { signal: controller.signal, maxRetries: 0 })
      .then((items) => { if (!controller.signal.aborted) setCollections(items) })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbort(error)) setCollectionsError(true)
      })
    return () => controller.abort()
  }, [])

  const pickCollection = (id: string, pickedTitle: string) => {
    setCollectionId(id)
    setPicking(false)
    clearFieldError('collection')
    /* Prefill the issue title from the picked collection — the curator still
       edits it, but "ai-weekly" → "ai-weekly" is the common case. */
    if (!title.trim()) {
      setTitle(pickedTitle)
      clearFieldError('title')
    }
  }

  const selectedTitle = collections?.find((item) => item.collection.id === collectionId)?.collection.title

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!collectionId) { setFieldError('collection', 'Pick a source collection.'); return }
    if (!title.trim()) { setFieldError('title', 'An issue needs a title.'); return }
    if (periodStart && periodEnd && periodEnd < periodStart) {
      setFieldError('period', 'The end date must be on or after the start date.')
      return
    }
    if (!issueKey.trim()) { setFieldError('key', 'An issue needs a key like 2026-W38.'); return }
    onAttach({
      collectionId,
      issueKey: issueKey.trim(),
      title: title.trim(),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(periodStart ? { periodStart: fromDateInput(periodStart) } : {}),
      ...(periodEnd ? { periodEnd: fromDateInput(periodEnd) } : {}),
    })
  }

  return (
    <>
    <Modal open onClose={onClose} label="New issue" title="New issue from a collection" size="md">
      <form className="edit-form" onSubmit={submit} data-testid="attach-issue-form">
        <p className="digest-note">
          The collection's bookmarks become the issue's entries. The issue starts as a draft — publish it when it is ready.
        </p>
        {collectionsError ? (
          <p className="field-error" role="alert">Couldn't load your collections. Close and try again.</p>
        ) : null}
        <div className="field">
          <label id="ai-collection-label" htmlFor="ai-collection">Source collection</label>
          <button
            type="button"
            id="ai-collection"
            className="btn btn-secondary digest-collection-pick"
            aria-labelledby="ai-collection-label"
            aria-haspopup="dialog"
            aria-invalid={errors.collection ? true : undefined}
            aria-describedby={errors.collection ? 'ai-collection-error' : undefined}
            disabled={busy || collections === null || collections.length === 0}
            onClick={() => setPicking(true)}
          >
            {selectedTitle
              ?? (collections === null ? 'Loading collections…' : 'Pick a collection')}
          </button>
          {collections !== null && collections.length === 0 ? (
            <span className="field-hint">You need at least one collection to publish an issue.</span>
          ) : null}
          {errors.collection ? (
            <p className="field-error" role="alert" id="ai-collection-error">{errors.collection}</p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="ai-title">Title</label>
          <input
            id="ai-title"
            value={title}
            onChange={(event) => { clearFieldError('title'); setTitle(event.target.value) }}
            maxLength={512}
            disabled={busy}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'ai-title-error' : undefined}
          />
          {errors.title ? <p className="field-error" role="alert" id="ai-title-error">{errors.title}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="ai-summary">Summary (optional)</label>
          <textarea id="ai-summary" value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={2000} disabled={busy} />
        </div>
        <div className="digest-form-pair">
          <div className="field">
            <label htmlFor="ai-period-start">Period start (optional)</label>
            <input
              id="ai-period-start"
              type="date"
              value={periodStart}
              onChange={(event) => {
                const next = event.target.value
                clearFieldError('period')
                setPeriodStart(next)
                // Until the curator types a key, it follows the period's week.
                if (next && !keyEdited) {
                  setIssueKey(isoWeekKey(new Date(`${next}T00:00:00`)))
                  clearFieldError('key')
                }
              }}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="ai-period-end">Period end (optional)</label>
            <input
              id="ai-period-end"
              type="date"
              value={periodEnd}
              onChange={(event) => { clearFieldError('period'); setPeriodEnd(event.target.value) }}
              disabled={busy}
              aria-invalid={errors.period ? true : undefined}
              aria-describedby={errors.period ? 'ai-period-error' : undefined}
            />
          </div>
        </div>
        {errors.period ? <p className="field-error" role="alert" id="ai-period-error">{errors.period}</p> : null}
        <details className="digest-advanced" open={errors.key ? true : undefined}>
          <summary>Advanced</summary>
          <div className="field">
            <label htmlFor="ai-key">Issue key</label>
            <input
              id="ai-key"
              value={issueKey}
              onChange={(event) => { clearFieldError('key'); setKeyEdited(true); setIssueKey(event.target.value) }}
              maxLength={128}
              disabled={busy}
              placeholder="2026-W38"
              aria-invalid={errors.key ? true : undefined}
              aria-describedby={errors.key ? 'ai-key-error' : undefined}
            />
            <span className="field-hint">Shown in the address of this issue. Must be unique in this digest.</span>
            {errors.key ? <p className="field-error" role="alert" id="ai-key-error">{errors.key}</p> : null}
          </div>
        </details>
        <div className="row-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || collections === null}>
            {busy ? 'Attaching…' : 'Attach as draft'}
          </button>
        </div>
      </form>
    </Modal>
    {picking && collections ? (
      <CollectionDestinationPicker
        mode="collection"
        owned={collections}
        onPick={(destination) => pickCollection(destination.collectionId, destination.collectionTitle)}
        onClose={() => setPicking(false)}
      />
    ) : null}
    </>
  )
}

/** Draft issue metadata — only drafts are editable (state machine). */
function EditIssueModal({ edition, busy, onClose, onSave }: {
  edition: ReportEdition
  busy: boolean
  onClose: () => void
  onSave: (patch: ReportEditionPatch) => void
}) {
  const [title, setTitle] = useState(edition.titleSnapshot)
  const [summary, setSummary] = useState(edition.summarySnapshot ?? '')
  const [periodStart, setPeriodStart] = useState(toDateInput(edition.periodStart))
  const [periodEnd, setPeriodEnd] = useState(toDateInput(edition.periodEnd))
  const [formError, setFormError] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) { setFormError('An issue needs a title.'); return }
    onSave({
      title: title.trim(),
      summary: summary.trim() || null,
      periodStart: fromDateInput(periodStart),
      periodEnd: fromDateInput(periodEnd),
    })
  }

  return (
    <Modal open onClose={onClose} label="Edit issue" title={`Edit issue ${edition.issueKey}`} size="md">
      <form className="edit-form" onSubmit={submit} data-testid="edit-issue-form">
        <div className="field">
          <label htmlFor="ei-title">Title</label>
          <input
            id="ei-title"
            value={title}
            onChange={(event) => { setFormError(null); setTitle(event.target.value) }}
            maxLength={512}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="ei-summary">Summary</label>
          <textarea id="ei-summary" value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={2000} disabled={busy} />
        </div>
        <div className="digest-form-pair">
          <div className="field">
            <label htmlFor="ei-period-start">Period start</label>
            <input id="ei-period-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="ei-period-end">Period end</label>
            <input id="ei-period-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} disabled={busy} />
          </div>
        </div>
        {formError ? <p className="field-error" role="alert">{formError}</p> : null}
        <div className="row-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save issue'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function DigestManage() {
  const { id = '' } = useParams()
  const { isLoggedIn, bootstrapping } = useAuth()
  const exposed = isReportsExposureEnabled() && isLoggedIn
  const manage = useReportManage(exposed ? id : null, exposed)
  const confirm = useConfirm()
  const { success, error } = useToast()
  const copyAddress = async (slug: string) => {
    try {
      await copyTextToClipboard(`${canonicalSiteOrigin()}${reportSeriesPath(slug)}`)
      success('Link copied')
    } catch {
      error('Couldn’t copy the link')
    }
  }
  const navigate = useNavigate()
  const [tab, setTab] = useState<ManageTab>('issues')
  const [attaching, setAttaching] = useState(false)
  const [editing, setEditing] = useState<ReportEdition | null>(null)
  const [memberSubject, setMemberSubject] = useState('')
  const [memberRole, setMemberRole] = useState<ReportMemberMutation['role']>('editor')

  /* Source-column titles: a best-effort id → title map of the curator's own
     collections. Issues whose source is not owned fall back to a quiet dash. */
  const [collections, setCollections] = useState<OwnedCollectionListItem[] | null>(null)
  useEffect(() => {
    if (!exposed) return
    const controller = new AbortController()
    productClient.loadOwnedCollections({ limit: 100 }, { signal: controller.signal, maxRetries: 0 })
      .then((items) => { if (!controller.signal.aborted) setCollections(items) })
      .catch(() => { /* the Source column degrades to '—' */ })
    return () => controller.abort()
  }, [exposed])
  const collectionTitles = useMemo(
    () => new Map((collections ?? []).map((item) => [item.collection.id, item.collection.title])),
    [collections],
  )

  const series = manage.series
  const busy = manage.op === 'saving'
  const archived = series?.state === 'archived'

  const publishIssue = async (edition: ReportEdition) => {
    const ok = await confirm({
      title: `Publish “${edition.titleSnapshot}”?`,
      body: 'Published issues become visible to everyone who can see this digest.',
      confirmLabel: 'Publish',
    })
    if (ok && (await manage.publishIssue(edition))) success('Issue published.')
  }

  const withdrawIssue = async (edition: ReportEdition) => {
    const ok = await confirm({
      title: `Withdraw “${edition.titleSnapshot}”?`,
      body: 'Readers will stop seeing this issue. A withdrawn issue cannot be republished or edited.',
      confirmLabel: 'Withdraw',
    })
    if (ok && (await manage.withdrawIssue(edition))) success('Issue withdrawn.')
  }

  const deleteIssue = async (edition: ReportEdition) => {
    const ok = await confirm({
      title: `Delete draft “${edition.titleSnapshot}”?`,
      body: 'The draft issue is detached from this digest. The source collection is not affected. This cannot be undone.',
      confirmLabel: 'Delete',
    })
    if (ok && (await manage.deleteIssue(edition))) success('Draft deleted.')
  }

  const archiveSeries = async () => {
    if (!series) return
    const ok = await confirm({
      title: `Archive “${series.title}”?`,
      body: 'The digest stops publishing and loses its public address. Existing issues stay attached but the digest is retired. This cannot be undone.',
      confirmLabel: 'Archive digest',
    })
    if (!ok) return
    if (await manage.archiveSeries()) {
      notifyMyReportsChanged()
      success('Digest archived')
      navigate('/library/digests')
    }
  }

  // Row actions follow the Library ⋯ grammar: only Publish stays visible on
  // a draft; Edit/Delete and Open/Withdraw live in the row menu so a long
  // archive does not paint a column of red Withdraw buttons.
  const issueActions = (edition: ReportEdition) => {
    if (archived) return null
    switch (edition.state) {
      case 'draft':
        return (
          <>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void publishIssue(edition)}>Publish</button>
            <RowActionMenu title={edition.titleSnapshot}>
              {({ run }) => (
                <>
                  <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => run(() => setEditing(edition))}>Edit</button>
                  <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => run(() => void deleteIssue(edition))}>Delete</button>
                </>
              )}
            </RowActionMenu>
          </>
        )
      case 'published':
        return (
          <RowActionMenu title={edition.titleSnapshot}>
            {({ run }) => (
              <>
                {series?.slug ? (
                  <Link
                    to={reportIssuePath(series.slug, edition.id)}
                    role="menuitem"
                    tabIndex={-1}
                    onKeyDown={onMenuLinkKeyDown}
                    onClick={() => run(() => undefined)}
                  >
                    Open
                  </Link>
                ) : null}
                <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => run(() => void withdrawIssue(edition))}>Withdraw</button>
              </>
            )}
          </RowActionMenu>
        )
      default:
        return null
    }
  }

  // The working draft leads the table; the rest keep their server order.
  const orderedIssues = [...manage.issues].sort((a, b) => Number(b.state === 'draft') - Number(a.state === 'draft'))

  const addMember = (event: FormEvent) => {
    event.preventDefault()
    const subjectId = memberSubject.trim()
    if (!subjectId) return
    void manage.putMember(subjectId, { role: memberRole }).then((ok) => {
      if (!ok) return
      setMemberSubject('')
      success('Collaborator added')
    })
  }

  const requestRemoveMember = async (subjectId: string) => {
    const ok = await confirm({
      title: 'Remove this collaborator?',
      body: `${subjectId} loses access to this digest.`,
      confirmLabel: 'Remove',
    })
    if (!ok) return
    if (await manage.removeMember(subjectId)) success('Collaborator removed')
  }

  const memberRemoveControls = (subjectId: string) => (
    <button type="button" className="btn btn-danger-ghost btn-sm collab-remove" disabled={busy || archived === true} onClick={() => void requestRemoveMember(subjectId)}>Remove</button>
  )

  const changeSchedule = async (next: 'off' | ScheduleFreq) => {
    if (!series || busy) return
    if (next === 'off') {
      if (!manage.schedule) return
      const ok = await confirm({
        title: 'Turn off the schedule?',
        body: 'The digest stops publishing new issues on a cadence. Existing issues are not affected.',
        confirmLabel: 'Turn off',
      })
      if (ok) {
        void manage.deleteSchedule().then((deleted) => {
          if (deleted) success('Schedule turned off')
        })
      }
      return
    }
    const input: ReportScheduleInput = {
      rrule: `FREQ=${next}`,
      dtstart: manage.schedule?.dtstart ?? new Date().toISOString(),
      timeZone: manage.schedule?.timeZone ?? browserTimeZone(),
      catchUpPolicy: 'skip',
      maxCatchUp: 0,
    }
    void manage.putSchedule(input).then((saved) => {
      if (saved) success('Schedule saved')
    })
  }

  if (!bootstrapping && isLoggedIn && (!exposed || manage.status === 'unavailable')) {
    return (
      <AbsenceStage
        title="Digest unavailable"
        description="This digest doesn't exist or isn't available."
        corners={ABSENCE_CORNERS.digest}
        exits={[{ to: '/library/digests', label: 'Your digests' }]}
      />
    )
  }

  return (
    <PageShell variant="grid">
      <div className="digest-manage-page" data-testid="digest-manage-page">
        {bootstrapping ? (
          <LoadingState label="Checking session…" />
        ) : !isLoggedIn ? (
          <>
            <PageHead variant="workbench" title="Digest" documentTitle="Digest" />
            <RouteState
              kind="auth"
              icon="link"
              title="Sign in to manage digests"
              description="Sign in to manage this digest series."
              returnTo={`/library/digests/${id}`}
            />
          </>
        ) : manage.status === 'error' && !series ? (
          <>
            <PageHead variant="workbench" title="Digest" documentTitle="Digest" />
            <RouteState kind="error" icon="alert" title="Couldn't load this digest" description={manage.message} onRetry={() => void manage.load()} />
          </>
        ) : manage.status === 'loading' || !series ? (
          <LoadingState label="Loading digest…" />
        ) : manage.status === 'error' ? (
          <>
            <PageHead variant="workbench" title="Digest" documentTitle="Digest" />
            <EmptyState
              role="alert"
              icon="alert"
              title="Couldn't load this digest"
              description={manage.message}
              action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void manage.load()}>Try again</button>}
            />
          </>
        ) : (
          <>
            <PageHead
              layout="split"
              variant="workbench"
              breadcrumb={
                <Breadcrumb
                  items={[
                    { label: 'Library', to: '/library' },
                    { label: 'Digests', to: '/library/digests' },
                    { label: series.title },
                  ]}
                />
              }
              title={series.title}
              documentTitle={series.title}
              lede={series.summary ?? undefined}
              afterTitle={series.slug ? (
                <span className="row gap-2">
                  <span>/reports/{series.slug}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyAddress(series.slug!)}>Copy link</button>
                </span>
              ) : undefined}
              actions={
                <>
                  {archived ? (
                    <StatusBadge tone="neutral">Archived</StatusBadge>
                  ) : (
                    <>
                      <StatusBadge tone={digestVisibilityTone(series)}>{digestVisibilityLabel(series)}</StatusBadge>
                    </>
                  )}
                  {series.slug && (series.visibility === 'public' || series.visibility === 'unlisted') ? (
                    <Link className="btn btn-secondary btn-sm" to={reportSeriesPath(series.slug)}>View public</Link>
                  ) : null}
                </>
              }
            />

            {manage.op !== 'idle' && manage.op !== 'saving' ? (
              <div className={`digest-op-bar ${OP_BAR_CLASS[manage.op] ?? ''}`} role={manage.op === 'error' ? 'alert' : 'status'} data-testid="digest-op-bar">
                <p>{manage.message}</p>
                <div className="digest-op-actions">
                  {manage.op === 'unknown' ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={manage.retryPending}>Try again</button>
                  ) : null}
                  {manage.op === 'unknown' || manage.op === 'conflict' ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={manage.startNewPending}>Start a new action</button>
                  ) : null}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={manage.dismissOp}>Dismiss</button>
                </div>
              </div>
            ) : null}

            <TabList
              label="Digest sections"
              value={tab}
              onChange={setTab}
              className="tab-rail"
              panelIdFor={(id) => `digest-panel-${id}`}
              tabIdFor={(id) => `digest-tab-${id}`}
              options={[
                { id: 'issues', label: 'Issues' },
                { id: 'settings', label: 'Settings' },
                { id: 'collaborators', label: 'Collaborators' },
              ]}
            />

            <section
              id="digest-panel-issues"
              role="tabpanel"
              aria-labelledby="digest-tab-issues"
              hidden={tab !== 'issues'}
            >
              <div className="digest-panel-head">
                <p className="digest-panel-count">{plural(manage.issues.length, 'issue')}</p>
                {!archived ? (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setAttaching(true)}>
                    New issue
                  </button>
                ) : null}
              </div>
              {manage.issues.length === 0 ? (
                <EmptyState
                  icon="book"
                  title="No issues yet"
                  description="Attach one of your collections to create the first draft issue."
                  action={!archived ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setAttaching(true)}>New issue</button> : undefined}
                />
              ) : (
                <DataTable
                  className="digest-table"
                  data-testid="digest-issue-table"
                  label="Digest issues"
                  columns={[
                    { key: 'no', label: 'No.', className: 'digest-table-num' },
                    { key: 'title', label: 'Title' },
                    { key: 'source', label: 'Source' },
                    { key: 'period', label: 'Period' },
                    { key: 'state', label: 'State' },
                    { key: 'actions', label: <span className="visually-hidden">Actions</span> },
                  ]}
                >
                  {orderedIssues.map((edition) => {
                    const sourceTitle = collectionTitles.get(edition.sourceCollectionId)
                    const periodMissing = !edition.periodStart || !edition.periodEnd
                    return (
                      <DataTableRow key={edition.id} data-testid="digest-issue-row">
                        <DataTableCell className="digest-table-num">No. {edition.editionOrdinal}</DataTableCell>
                        <DataTableCell>
                          <strong>{edition.titleSnapshot}</strong>
                          <small className="digest-table-key">{edition.issueKey}</small>
                        </DataTableCell>
                        <DataTableCell
                          data-label="Source"
                          data-empty={sourceTitle === undefined ? '' : undefined}
                        >
                          {sourceTitle ?? '—'}
                        </DataTableCell>
                        <DataTableCell
                          data-label="Period"
                          data-empty={periodMissing ? '' : undefined}
                        >
                          {periodLabel(edition)}
                        </DataTableCell>
                        <DataTableCell data-label="State">
                          <StatusBadge tone={ISSUE_STATE_TONE[edition.state]}>
                            {ISSUE_STATE_LABEL[edition.state]}
                          </StatusBadge>
                        </DataTableCell>
                        <DataTableCell className="digest-table-actions">{issueActions(edition)}</DataTableCell>
                      </DataTableRow>
                    )
                  })}
                </DataTable>
              )}
              {manage.issuesCursor ? (
                <div className="digest-table-more">
                  {manage.moreError ? (
                    <p className="field-error" role="alert">Couldn't load more issues. Try again.</p>
                  ) : null}
                  <div className="row-end">
                    <LoadMoreButton
                      loading={manage.loadingMore}
                      onClick={() => void manage.loadMoreIssues()}
                    >
                      Load more issues
                    </LoadMoreButton>
                  </div>
                </div>
              ) : null}
            </section>

            <section
              id="digest-panel-settings"
              role="tabpanel"
              aria-labelledby="digest-tab-settings"
              hidden={tab !== 'settings'}
            >
              <div className="digest-settings-stack">
                <SettingsPanel
                  key={`${series.id}:${series.resourceRevision}`}
                  series={series}
                  busy={busy || archived === true}
                  onSave={async (patch, commitCatalog) => {
                    if (patch.visibility === 'public' && series.visibility !== 'public') {
                      const ok = await confirm({
                        title: 'Make this digest public?',
                        body: 'Public digests appear in the directory, and readers can follow them. You can switch back at any time.',
                        confirmLabel: 'Make public',
                      })
                      if (!ok) return
                    }
                    // Catalog first: a series save bumps the revision and
                    // remounts this form, which would reload the catalog
                    // under an in-flight tag/language commit.
                    if (!(await commitCatalog())) return
                    if (Object.keys(patch).length > 0) {
                      if (!(await manage.patchSeries(patch))) return
                      notifyMyReportsChanged()
                    }
                    success('Settings saved')
                  }}
                />

                <section className="digest-card edit-form" data-testid="digest-schedule">
                  <header className="digest-card-head">
                    <h2>Schedule</h2>
                    <p>Open a new issue on a regular cadence. Saves automatically.</p>
                  </header>
                  <div className="digest-card-body">
                    <div className="field">
                      <label htmlFor="digest-schedule-freq">Repeat</label>
                      <select
                        id="digest-schedule-freq"
                        value={manage.schedule ? (freqOf(manage.schedule.rrule) ?? 'custom') : 'off'}
                        disabled={busy || archived === true}
                        onChange={(event) => {
                          const value = event.target.value
                          if (value !== 'custom') void changeSchedule(value as 'off' | ScheduleFreq)
                        }}
                      >
                        <option value="off">Off</option>
                        {SCHEDULE_FREQS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                        {manage.schedule && freqOf(manage.schedule.rrule) === null ? (
                          <option value="custom" disabled>Custom rule</option>
                        ) : null}
                      </select>
                      {manage.schedule ? (
                        <span className="field-hint" data-testid="digest-schedule-summary">
                          {freqLabel(freqOf(manage.schedule.rrule))} · {manage.schedule.timeZone}
                          {manage.schedule.nextRunAt ? ` · next run ${formatDateTime(manage.schedule.nextRunAt)}` : ''}
                        </span>
                      ) : (
                        <span className="field-hint">Off. You publish issues yourself.</span>
                      )}
                    </div>
                  </div>
                </section>

                {!archived ? (
                  <section className="digest-card digest-danger-zone">
                    <div>
                      <h2>Archive this digest</h2>
                      <p>The digest stops publishing and loses its public address. This cannot be undone.</p>
                    </div>
                    <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void archiveSeries()}>
                      Archive digest
                    </button>
                  </section>
                ) : null}
              </div>
            </section>

            <section
              id="digest-panel-collaborators"
              role="tabpanel"
              aria-labelledby="digest-tab-collaborators"
              hidden={tab !== 'collaborators'}
            >
              {manage.members === null ? (
                <EmptyState
                  icon="collection"
                  title="Collaborators are owner-only"
                  description="Only the digest owner can see and manage collaborators."
                />
              ) : (
                <div data-testid="digest-members">
                  <form className="collab-invite" onSubmit={addMember}>
                    <div>
                      <p className="section-label">Invite someone</p>
                      <h2>Add a collaborator</h2>
                      <p>Roles can be changed at any time. Digest members are granted by account ID (subject ID).</p>
                    </div>
                    <div className="collab-invite-fields">
                      <div className="field">
                        <label htmlFor="member-subject">Account ID</label>
                        <input
                          id="member-subject"
                          value={memberSubject}
                          onChange={(event) => setMemberSubject(event.target.value)}
                          placeholder="acct_…"
                          disabled={busy || archived === true}
                        />
                      </div>
                      <div className="field">
                        <label id="member-role-label">Role</label>
                        <RolePick
                          id="member-role"
                          labelledBy="member-role-label"
                          value={toInviteRole(memberRole)}
                          disabled={busy || archived === true}
                          onChange={(role) => setMemberRole(toMemberRole(role))}
                        />
                      </div>
                      <button type="submit" className="btn btn-primary" disabled={busy || archived === true || !memberSubject.trim()}>
                        Add collaborator
                      </button>
                    </div>
                  </form>
                  <section className="collab-members">
                    <div className="section-head section-head--split">
                      <div>
                        <p className="section-label">People with access</p>
                        <h2>{plural(manage.members.length, 'collaborator')}</h2>
                      </div>
                    </div>
                    <div className="collab-member-list">
                      {manage.members.map((member) => (
                        <article className="collab-member" key={member.subjectId} data-testid="digest-member-row">
                          <span className="avatar avatar-md" aria-hidden>
                            {member.subjectId.slice(0, 2).toUpperCase()}
                          </span>
                          <div className="collab-member-copy">
                            <span><strong>{member.subjectId}</strong></span>
                            <small>Account ID</small>
                          </div>
                          {member.role === 'owner' ? (
                            <span className="collab-owner">Owner</span>
                          ) : (
                            <RolePick
                              label={`Role for ${member.subjectId}`}
                              value={toInviteRole(member.role)}
                              disabled={busy || archived === true}
                              onChange={(role) => {
                                void manage.putMember(member.subjectId, { role: toMemberRole(role) }).then((ok) => {
                                  if (ok) success('Role updated')
                                })
                              }}
                            />
                          )}
                          {member.role !== 'owner' ? memberRemoveControls(member.subjectId) : null}
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </section>
          </>
        )}

        {attaching ? (
          <AttachIssueModal
            busy={busy}
            onClose={() => setAttaching(false)}
            onAttach={(body) => {
              void manage.createIssue(body).then((ok) => { if (ok) setAttaching(false) })
            }}
          />
        ) : null}
        {editing ? (
          <EditIssueModal
            edition={editing}
            busy={busy}
            onClose={() => setEditing(null)}
            onSave={(patch) => {
              void manage.patchIssue(editing, patch).then((ok) => { if (ok) setEditing(null) })
            }}
          />
        ) : null}
      </div>
    </PageShell>
  )
}

/** Settings form — series metadata merge-patch. Local draft state resets when
    the series revision changes (key on the parent) so a server refresh never
    fights the caret. */
function SettingsPanel({ series, busy, onSave }: {
  series: ReportSeries
  busy: boolean
  /** One commit for General + Catalog: the patch may be empty when only
      tags or language changed. */
  onSave: (patch: ReportSeriesPatch, commitCatalog: CatalogCommit) => Promise<void>
}) {
  const catalogCommit = useRef<CatalogCommit | null>(null)
  const [catalogDirty, setCatalogDirty] = useState(false)
  const [title, setTitle] = useState(series.title)
  const [summary, setSummary] = useState(series.summary ?? '')
  const [slug, setSlug] = useState(series.slug ?? '')
  const [visibility, setVisibility] = useState<DigestVisibility>(series.visibility)
  const [allowSearchIndexing, setAllowSearchIndexing] = useState(series.allowSearchIndexing)
  const [formError, setFormError] = useState<string | null>(null)

  const dirty =
    title !== series.title
    || summary !== (series.summary ?? '')
    || slug !== (series.slug ?? '')
    || visibility !== series.visibility
    || allowSearchIndexing !== series.allowSearchIndexing
  const anyDirty = dirty || catalogDirty

  useConfirmLeaveGuard(anyDirty && !busy, {
    title: 'Discard changes?',
    body: 'You have unsaved changes to this digest’s settings.',
    confirmLabel: 'Discard',
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle) { setFormError('A digest needs a title.'); return }
    const patch: ReportSeriesPatch = {}
    if (trimmedTitle !== series.title) patch.title = trimmedTitle
    const trimmedSummary = summary.trim()
    if (trimmedSummary !== (series.summary ?? '')) patch.summary = trimmedSummary || null
    const trimmedSlug = slug.trim()
    if (trimmedSlug !== (series.slug ?? '')) patch.slug = trimmedSlug || null
    if (visibility !== series.visibility) patch.visibility = visibility
    if (allowSearchIndexing !== series.allowSearchIndexing) patch.allowSearchIndexing = allowSearchIndexing
    if (Object.keys(patch).length === 0 && !catalogDirty) return
    const commit = catalogCommit.current
    void onSave(patch, commit ?? (async () => true))
  }

  const slugHint = series.slug && slug.trim() !== series.slug
    ? `Changing the address breaks existing links to /reports/${series.slug}.`
    : 'Lowercase letters, numbers and dashes — becomes the public address /reports/<slug>. Leave empty to keep the digest unaddressed.'
  const visibilityHint = DIGEST_VISIBILITIES.find((option) => option.value === visibility)?.hint

  return (
    <form className="digest-card edit-form" onSubmit={submit} data-testid="digest-settings-form">
      <header className="digest-card-head">
        <h2>General</h2>
        <p>How the digest is named, where it lives and who can open it.</p>
      </header>
      <div className="digest-card-body">
        <div className="field">
          <label htmlFor="ds-title">Title</label>
          <input
            id="ds-title"
            value={title}
            onChange={(event) => { setFormError(null); setTitle(event.target.value) }}
            maxLength={512}
            disabled={busy}
          />
          {formError ? <p className="field-error" role="alert">{formError}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="ds-summary">Summary</label>
          <textarea id="ds-summary" value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={2000} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="ds-slug">Public address</label>
          <div className="digest-address">
            <span className="digest-address-prefix" aria-hidden>/reports/</span>
            <input id="ds-slug" value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={128} disabled={busy} />
          </div>
          <span className="field-hint">{slugHint}</span>
        </div>
        <div className="field">
          <label htmlFor="ds-visibility">Visibility</label>
          <select
            id="ds-visibility"
            value={visibility}
            onChange={(event) => {
              const next = event.target.value as DigestVisibility
              setVisibility(next)
              if (next !== 'public') setAllowSearchIndexing(false)
            }}
            disabled={busy}
          >
            {DIGEST_VISIBILITIES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="field-hint">{visibilityHint}</span>
        </div>
        <div className="field">
          <span className="digest-field-label">Search engines</span>
          <label className="digest-check" htmlFor="ds-indexing">
            <input
              id="ds-indexing"
              type="checkbox"
              checked={allowSearchIndexing}
              onChange={(event) => setAllowSearchIndexing(event.target.checked)}
              disabled={busy || visibility !== 'public'}
            />
            Allow search indexing
          </label>
          <span className="field-hint">
            {visibility === 'public'
              ? 'Lets search engines index the public pages.'
              : 'Available when visibility is Public.'}
          </span>
        </div>
        <div className="digest-settings-catalog" data-testid="report-catalog-fields">
          <h3 className="section-label">Catalog</h3>
          <p className="field-hint">Tags and language help readers find this digest in the directory.</p>
          <CatalogFields
            kind="report"
            resourceId={series.id}
            disabled={busy}
            commitRef={catalogCommit}
            onDirtyChange={setCatalogDirty}
          />
        </div>
      </div>
      <footer className="digest-card-foot">
        {anyDirty ? <span className="meta" role="status">Unsaved changes</span> : null}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !anyDirty}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </footer>
    </form>
  )
}
