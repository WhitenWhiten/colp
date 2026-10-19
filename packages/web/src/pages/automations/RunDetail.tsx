import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { AutomationJob, AutomationRun } from '../../api/automationTypes'
import { useToast } from '../../components/AppToast'
import { Breadcrumb } from '../../components/Breadcrumb'
import { useConfirm } from '../../components/ConfirmModal'
import { Icon, type IconName } from '../../components/Icon'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge, type StatusTone } from '../../components/StatusBadge'
import { classifyRouteError } from '../../lib/classifyRouteError'
import { formatDate, formatDateTime, formatRelative } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import {
  capitalize,
  JOB_STATUS,
  RUN_HEADLINE,
  RUN_KIND,
  RUN_STATUS,
  RUN_STATUS_DETAIL,
  runExplanation,
  runHasRemainingWork,
  taskPhrase,
} from './copy'
import { ruleEditPath, rulePath, runPath } from './paths'
import { RunEffects } from './RunEffects'
import { RunOutputs } from './RunOutputs'
import { errorMessage, isStale, useAutomationDeps, useLoad } from './shared'
import { UsagePanel } from './UsagePanel'

/* One run (AU-13/22/27): the state the server gives it in plain words, what
   it changed with per-effect Undo, its agent steps with the one action each
   state allows, and Cancel for what is left. The page never decides whether
   a step can be retried or a run cancelled; it asks, and shows the answer. */

/** A run's steps are read one by one; past this, the page says how many it left out. */
const MAX_JOBS = 25
const POLL_FIRST_MS = 3_000
const POLL_MAX_MS = 30_000

const STATE_ICON: Record<StatusTone, IconName> = {
  neutral: 'info',
  muted: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
  accent: 'play',
}

type JobSlot = { id: string; job: AutomationJob | null; error: unknown }

function useRunJobs(run: AutomationRun | null, refreshKey: number) {
  const { api } = useAutomationDeps()
  const ids = run ? run.jobIds.slice(0, MAX_JOBS) : []
  const key = ids.join(',')
  const [slots, setSlots] = useState<JobSlot[] | null>(null)
  const request = useRef(0)
  const active = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!key) {
      setSlots([])
      return
    }
    const controller = new AbortController()
    const generation = ++request.current
    active.current = controller
    void Promise.all(key.split(',').map(async (id): Promise<JobSlot> => {
      try {
        return { id, job: await api.getJob(id, controller.signal), error: null }
      } catch (error) {
        return { id, job: null, error }
      }
    })).then((loaded) => {
      if (!controller.signal.aborted && generation === request.current) setSlots(loaded)
    })
    return () => {
      controller.abort()
      if (active.current === controller) active.current = null
    }
  }, [api, key, refreshKey])

  const replace = (job: AutomationJob) => {
    request.current += 1
    active.current?.abort()
    setSlots((current) => current?.map((slot) => (slot.id === job.id ? { ...slot, job } : slot)) ?? current)
  }
  return { slots, replace }
}

function JobRow({ job, busy, onRetry }: { job: AutomationJob; busy: boolean; onRetry: () => void }) {
  const status = JOB_STATUS[job.status]
  const explanation = runExplanation(job.explanation)
  return (
    <li className="automation-job" id={`job-${job.id}`} data-job-id={job.id} data-status={job.status}>
      <div className="automation-job-body">
        <p className="automation-job-title">
          {capitalize(taskPhrase(job.task.type))}
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </p>
        {status.detail && <p className="automation-job-text">{status.detail}</p>}
        {explanation && explanation !== status.detail && <p className="automation-job-text">{explanation}</p>}
        <p className="automation-meta">
          <time dateTime={job.createdAt} title={formatDateTime(job.createdAt)}>{formatRelative(job.createdAt)}</time>
          {job.attemptGeneration > 1 ? ` · attempt ${job.attemptGeneration}` : null}
        </p>
      </div>
      {job.status === 'awaitingApproval' && (
        <Link className="btn btn-secondary btn-sm" to={job.planId ? `/approvals/${encodeURIComponent(job.planId)}` : '/approvals'}>
          Review in Approvals
        </Link>
      )}
      {job.status === 'uncertain' && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onRetry}>Try again</button>
      )}
    </li>
  )
}

export function RunDetail() {
  const { runId = '' } = useParams<{ runId: string }>()
  const { api } = useAutomationDeps()
  const confirm = useConfirm()
  const { success, error: toastError } = useToast()
  const run = useLoad(`run:${runId}`, (signal) => api.getRun(runId, signal))
  const current = run.state.status === 'ready' ? run.state.data : null
  const rule = useLoad(current ? `rule:${current.ruleId}` : null, (signal) => api.getRule(current?.ruleId ?? '', signal))
  const [refreshKey, setRefreshKey] = useState(0)
  const jobs = useRunJobs(current, refreshKey)
  const [busy, setBusy] = useState<string | null>(null)
  const poll = useRef({ revision: '', attempt: 0 })
  const runStatus = current?.status
  const runRevision = current?.revision
  const reloadRun = run.reload

  useEffect(() => {
    if (!runStatus || runRevision === undefined || !runHasRemainingWork(runStatus)) return
    if (poll.current.revision !== runRevision) poll.current = { revision: runRevision, attempt: 0 }
    const delay = Math.min(POLL_FIRST_MS * 2 ** poll.current.attempt, POLL_MAX_MS)
    const timer = window.setTimeout(() => {
      poll.current.attempt += 1
      reloadRun()
      setRefreshKey((value) => value + 1)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [runStatus, runRevision, refreshKey, reloadRun])

  function refresh() {
    run.reload()
    setRefreshKey((value) => value + 1)
  }

  if (run.state.status === 'error') {
    const kind = classifyRouteError(run.state.error)
    return (
      <PageShell>
        <RouteState
          kind={kind}
          icon="compass"
          titleAs="h1"
          title={kind === 'unavailable' ? 'This run is not available' : undefined}
          description={kind === 'unavailable' ? 'It may belong to another account, or its history is no longer kept.' : undefined}
          feature="Automations"
          onRetry={run.reload}
        />
      </PageShell>
    )
  }
  if (!current) {
    return <PageShell><RouteState kind="loading" loadingLabel="Loading run…" /></PageShell>
  }

  const shown: AutomationRun = current
  const ruleName = rule.state.status === 'ready' ? rule.state.data.definition.name : null
  const status = RUN_STATUS[shown.status]
  const explanation = runExplanation(shown.explanation)
  const finished = !runHasRemainingWork(shown.status)
  /** Done or cancelled: nothing about the run itself changes any more (an Undo updates in place). */
  const settled = shown.status === 'completed' || shown.status === 'cancelled'
  const stateDetail = [RUN_STATUS_DETAIL[shown.status], shown.held ? 'It is on hold and does not go on by itself.' : '']
    .filter(Boolean).join(' ')
  const underway = shown.status === 'waiting' || shown.status === 'running'

  async function cancel() {
    const accepted = await confirm({
      title: 'Cancel the rest of this run?',
      body: 'Work that has not happened yet is cancelled. Anything already done stays, and you can undo it separately.',
      confirmLabel: 'Cancel remaining work',
      cancelLabel: 'Keep running',
    })
    if (!accepted) return
    setBusy('cancel')
    try {
      run.replace(await api.cancelRun(shown.id, shown.revision))
      setRefreshKey((value) => value + 1)
      success('Cancelled. Anything already done stays.')
    } catch (error) {
      if (isStale(error)) run.reload()
      toastError(isStale(error)
        ? 'This run changed while you were looking. Check it again.'
        : errorMessage(error, 'Could not cancel this run.'))
    } finally {
      setBusy(null)
    }
  }

  async function retry(job: AutomationJob) {
    setBusy(job.id)
    try {
      jobs.replace(await api.retryJob(job.id, job.revision))
      run.reload()
      success('Trying again with the original settings.')
    } catch (error) {
      toastError(errorMessage(error, 'This step can’t be tried again.'))
    } finally {
      setBusy(null)
    }
  }

  const children = shown.childRunIds ?? []
  const hiddenJobs = shown.jobIds.length - MAX_JOBS
  return (
    <PageShell data-testid="automation-run">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={(
          <Breadcrumb items={[
            { label: 'Automations', to: '/automations' },
            { label: ruleName ?? 'Rule', to: rulePath(shown.ruleId) },
            { label: 'Run' },
          ]}
          />
        )}
        eyebrow={`${RUN_KIND[shown.kind]} · ${formatDate(shown.createdAt)}`}
        title={RUN_HEADLINE[shown.status]}
        documentTitle={`Run of ${ruleName ?? 'a rule'}`}
        afterTitle={(
          <span className="automation-head-state">
            <StatusBadge tone={status.tone} data-testid="automation-run-status">{status.label}</StatusBadge>
            {shown.held && <StatusBadge tone="warning">On hold</StatusBadge>}
            {stateDetail && <span>{stateDetail}</span>}
            {shown.held && <Link to={`${ruleEditPath(shown.ruleId)}#preview`}>Review earlier work and choose whether to continue</Link>}
          </span>
        )}
        actions={!finished ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>Refresh</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void cancel()}>
              Cancel remaining work
            </button>
          </>
        ) : settled ? undefined : <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>Refresh</button>}
      />

      <div className="automations-layout">
        <div className="automations-main">
          {explanation && (
            <div className="automation-run-state" data-tone={status.tone}>
              <span className="automation-run-state-icon" aria-hidden><Icon name={STATE_ICON[status.tone]} /></span>
              <div>
                <h2 className="automation-panel-title">What happened</h2>
                <p data-testid="automation-run-explanation">{explanation}</p>
              </div>
            </div>
          )}

          {shown.outputCount > 0 && <RunOutputs run={shown} onRunChanged={run.reload} />}

          <section className="automations-section" aria-labelledby="automation-run-effects">
            <div className="automations-section-head">
              <h2 id="automation-run-effects">What it changed</h2>
            </div>
            {shown.effects.length > 0 ? (
              <RunEffects run={shown} from="run" onSettled={(next) => {
                if (next) { run.replace(next); setRefreshKey((value) => value + 1) }
                else refresh()
              }} />
            ) : (
              <p className="automation-panel-text automation-empty-line">
                {underway ? 'Nothing yet.' : 'Nothing was changed.'}
              </p>
            )}
          </section>

          {shown.jobIds.length > 0 && (
            <section className="automations-section" aria-labelledby="automation-run-jobs">
              <div className="automations-section-head">
                <h2 id="automation-run-jobs">Agent work</h2>
                <span className="automations-count">{shown.jobIds.length}</span>
              </div>
              {jobs.slots === null && <RouteState kind="loading" loadingLabel="Loading agent work…" />}
              {jobs.slots && (
                <ul className="automation-jobs">
                  {jobs.slots.map((slot) => slot.job ? (
                    <JobRow key={slot.id} job={slot.job} busy={busy !== null} onRetry={() => slot.job && void retry(slot.job)} />
                  ) : (
                    <li key={slot.id} className="automation-job" data-status="unreadable">
                      <p className="automation-job-text">{errorMessage(slot.error, 'This step could not be loaded.')}</p>
                    </li>
                  ))}
                </ul>
              )}
              {hiddenJobs > 0 && <p className="automation-meta">{plural(hiddenJobs, 'more step')} not shown.</p>}
            </section>
          )}

          {children.length > 0 && (
            <section className="automations-section" aria-labelledby="automation-run-children">
              <div className="automations-section-head">
                <h2 id="automation-run-children">Bookmarks in this run</h2>
                <span className="automations-count">{children.length}</span>
              </div>
              <p className="automation-meta">Each bookmark has its own run, with its own changes and Undo.</p>
              <ol className="automation-child-runs">
                {children.map((id, index) => (
                  <li key={id}><Link to={runPath(id)}>Bookmark {index + 1}</Link></li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <div className="automation-side">
          <section className="automation-panel" aria-labelledby="automation-run-about">
            <h2 id="automation-run-about" className="automation-panel-title">About this run</h2>
            <dl className="automation-facts">
              <div><dt>Rule</dt><dd><Link to={rulePath(shown.ruleId)}>{ruleName ?? 'Open rule'}</Link></dd></div>
              <div><dt>Kind</dt><dd>{RUN_KIND[shown.kind]}</dd></div>
              <div><dt>Started</dt><dd><time dateTime={shown.createdAt} title={formatDateTime(shown.createdAt)}>{formatDateTime(shown.createdAt)}</time></dd></div>
              <div><dt>Last change</dt><dd><time dateTime={shown.updatedAt} title={formatDateTime(shown.updatedAt)}>{formatRelative(shown.updatedAt)}</time></dd></div>
              <div><dt>Rule version</dt><dd>{shown.ruleRevision}</dd></div>
            </dl>
            <p className="automation-meta">
              A run keeps the rule as it was when it started, so later edits don’t change it.
            </p>
          </section>
          {/* Without the server's counts there is nothing true to say here; the steps are listed beside it.
              A run with no agent steps only filed a bookmark: there is no agent work to count. */}
          {shown.usage && shown.jobIds.length > 0 && (
            <UsagePanel usage={shown.usage} title="This run’s work" headingId="automation-run-usage" scope="run" />
          )}
        </div>
      </div>
    </PageShell>
  )
}
