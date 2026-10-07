import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isProductApiError,
  productClient,
  type ReportEdition,
  type ReportEditionAttach,
  type ReportEditionPatch,
  type ReportMember,
  type ReportMemberMutation,
  type ReportSchedule,
  type ReportScheduleInput,
  type ReportSeries,
  type ReportSeriesPatch,
} from '../api'
import { isAbort } from './libraryTree'

export type ReportManageStatus = 'loading' | 'ready' | 'error' | 'unavailable'
export type ReportManageOp = 'idle' | 'saving' | 'unknown' | 'stale' | 'conflict' | 'error'

const ISSUES_PAGE_LIMIT = 50

const etag = (revision: string) => `"${revision.replaceAll('"', '')}"`

type PendingMutation = {
  intentId: string
  busyLabel: string
  doneLabel: string
  execute: (intentId: string, signal: AbortSignal) => Promise<unknown>
}

/**
 * Curator management state for one report series (R10-05/36): the private
 * series projection, its editions, schedule and members, plus the mutation
 * runner every write goes through.
 *
 * Every mutation rides the same receipt discipline as useRelationWorkflow:
 * the caller builds an intentId once per user intent, If-Match carries the
 * loaded entity's revision (series/edition resourceRevision, members
 * policyRevision; schedule If-Match is optional and only sent when a
 * schedule already exists), 412 refreshes into `stale`, transport failures
 * park the intent in `unknown` until retried or abandoned, and a reused
 * command id surfaces as `conflict` instead of silently replaying.
 */
export function useReportManage(reportId: string | null, exposed: boolean) {
  const [series, setSeries] = useState<ReportSeries | null>(null)
  const [issues, setIssues] = useState<ReportEdition[]>([])
  const [issuesCursor, setIssuesCursor] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<ReportSchedule | null>(null)
  const [members, setMembers] = useState<ReportMember[] | null>(null)
  const [status, setStatus] = useState<ReportManageStatus>('loading')
  const [op, setOp] = useState<ReportManageOp>('idle')
  const [message, setMessage] = useState('Loading digest')
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const pendingRef = useRef<PendingMutation | null>(null)
  const loadedRef = useRef(false)
  const generationRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const mutationControllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!reportId || !exposed) { setStatus('unavailable'); return }
    const generation = ++generationRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    /* Only the first paint shows the loading state; mutation-triggered
       reloads refresh silently so the page never blanks under the cursor. */
    if (!loadedRef.current) { setStatus('loading'); setMessage('Loading digest') }
    try {
      /* Series and editions are the page; schedule and members ride
         allSettled because a non-owner collaborator can read the series but
         may not read the policy surface — a 403 there must not blank the
         Issues tab. */
      const [nextSeries, issuesPage, scheduleResult, membersResult] = await Promise.all([
        productClient.getReport(reportId, { signal: controller.signal, maxRetries: 0 }),
        productClient.listReportIssues(reportId, { limit: ISSUES_PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 }),
        productClient.getReportSchedule(reportId, { signal: controller.signal, maxRetries: 0 }).catch(() => null),
        productClient.listReportMembers(reportId, { signal: controller.signal, maxRetries: 0 }).catch(() => null),
      ])
      if (controller.signal.aborted || generation !== generationRef.current) return
      loadedRef.current = true
      setSeries(nextSeries)
      setIssues(issuesPage.items)
      setIssuesCursor(issuesPage.nextCursor)
      setMoreError(false)
      setSchedule(scheduleResult?.schedule ?? null)
      setMembers(membersResult ? membersResult.items.filter((member) => !member.revokedAt) : null)
      setStatus('ready')
      setOp((current) => (current === 'saving' ? 'idle' : current))
    } catch (error) {
      if (controller.signal.aborted || generation !== generationRef.current || isAbort(error)) return
      if (isProductApiError(error) && (error.status === 404 || error.code === 'resource_not_found')) {
        setStatus('unavailable')
        return
      }
      setStatus('error')
      setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load this digest")
    }
  }, [reportId, exposed])

  const loadMoreIssues = useCallback(async () => {
    const cursor = issuesCursor
    if (!reportId || !cursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listReportIssues(reportId, { cursor }, { maxRetries: 0 })
      setIssues((current) => {
        const seen = new Set(current.map((issue) => issue.id))
        return [...current, ...page.items.filter((issue) => !seen.has(issue.id))]
      })
      setIssuesCursor(page.nextCursor)
      setMoreError(false)
    } catch {
      setMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }, [reportId, issuesCursor, loadingMore])

  useEffect(() => {
    void load()
    return () => {
      generationRef.current += 1
      loadControllerRef.current?.abort()
      mutationControllerRef.current?.abort()
    }
  }, [load])

  const run = useCallback(async (pending: PendingMutation): Promise<boolean> => {
    pendingRef.current = pending
    mutationControllerRef.current?.abort()
    const controller = new AbortController()
    mutationControllerRef.current = controller
    const generation = generationRef.current
    setOp('saving')
    setMessage(pending.busyLabel)
    try {
      await pending.execute(pending.intentId, controller.signal)
      if (controller.signal.aborted || generation !== generationRef.current) return false
      pendingRef.current = null
      await load()
      if (generationRef.current === generation + 1) { setOp('idle'); setMessage(pending.doneLabel) }
      return true
    } catch (error) {
      if (controller.signal.aborted || generation !== generationRef.current || isAbort(error)) return false
      if (isProductApiError(error) && error.code === 'precondition_failed') {
        productClient.abandonReportManageIntent(pending.intentId)
        pendingRef.current = null
        await load()
        if (generationRef.current === generation + 1) {
          setOp('stale')
          setMessage('This digest changed on the server. Review the refreshed data and try again.')
        }
        return false
      }
      if (isProductApiError(error) && error.code === 'transport_error') {
        setOp('unknown')
        setMessage('The change may not have been applied. Try again before making other changes.')
        return false
      }
      if (isProductApiError(error) && error.code === 'command_id_reused') {
        setOp('conflict')
        setMessage('This action conflicts with an earlier request. Try again.')
        return false
      }
      setOp('error')
      setMessage(isProductApiError(error) ? error.recoveryHint : 'The change could not be saved')
      return false
    }
  }, [load])

  const intent = (scope: string) => productClient.mutationIntentKey(scope, productClient.newCommandId())
  const mutationOptions = (intentId: string, signal: AbortSignal) => ({ intentId, maxRetries: 0 as const, signal })

  const createIssue = useCallback((body: ReportEditionAttach) => {
    if (!reportId) return Promise.resolve(false)
    return run({
      intentId: intent('attach-report-issue'),
      busyLabel: 'Attaching the collection as an issue',
      doneLabel: 'Issue attached as a draft',
      execute: (intentId, signal) => productClient.createReportIssue(reportId, body, mutationOptions(intentId, signal)),
    })
  }, [reportId, run])

  const patchIssue = useCallback((edition: ReportEdition, patch: ReportEditionPatch) => {
    if (!reportId) return Promise.resolve(false)
    return run({
      intentId: intent('patch-report-issue'),
      busyLabel: 'Saving the issue',
      doneLabel: 'Issue saved',
      execute: (intentId, signal) => productClient.patchReportIssue(reportId, edition.id, patch, etag(edition.resourceRevision), mutationOptions(intentId, signal)),
    })
  }, [reportId, run])

  const deleteIssue = useCallback((edition: ReportEdition) => {
    if (!reportId) return Promise.resolve(false)
    return run({
      intentId: intent('detach-report-issue'),
      busyLabel: 'Deleting the issue',
      doneLabel: 'Issue deleted',
      execute: (intentId, signal) => productClient.deleteReportIssue(reportId, edition.id, etag(edition.resourceRevision), mutationOptions(intentId, signal)),
    })
  }, [reportId, run])

  const publishIssue = useCallback((edition: ReportEdition) => {
    if (!reportId) return Promise.resolve(false)
    return run({
      intentId: intent('publish-report-issue'),
      busyLabel: 'Publishing the issue',
      doneLabel: 'Issue published',
      execute: (intentId, signal) => productClient.publishReportIssue(reportId, edition.id, etag(edition.resourceRevision), mutationOptions(intentId, signal)),
    })
  }, [reportId, run])

  const withdrawIssue = useCallback((edition: ReportEdition) => {
    if (!reportId) return Promise.resolve(false)
    return run({
      intentId: intent('withdraw-report-issue'),
      busyLabel: 'Withdrawing the issue',
      doneLabel: 'Issue withdrawn',
      execute: (intentId, signal) => productClient.withdrawReportIssue(reportId, edition.id, etag(edition.resourceRevision), mutationOptions(intentId, signal)),
    })
  }, [reportId, run])

  const patchSeries = useCallback((patch: ReportSeriesPatch) => {
    if (!series) return Promise.resolve(false)
    return run({
      intentId: intent('patch-report'),
      busyLabel: 'Saving digest settings',
      doneLabel: 'Digest settings saved',
      execute: (intentId, signal) => productClient.patchReport(series.id, patch, etag(series.resourceRevision), mutationOptions(intentId, signal)),
    })
  }, [series, run])

  const archiveSeries = useCallback(() => {
    if (!series) return Promise.resolve(false)
    return run({
      intentId: intent('archive-report'),
      busyLabel: 'Archiving the digest',
      doneLabel: 'Digest archived',
      execute: (intentId, signal) => productClient.deleteReport(series.id, etag(series.resourceRevision), mutationOptions(intentId, signal)),
    })
  }, [series, run])

  const putSchedule = useCallback((input: ReportScheduleInput) => {
    if (!series) return Promise.resolve(false)
    return run({
      intentId: intent('put-report-schedule'),
      busyLabel: 'Saving the schedule',
      doneLabel: 'Schedule saved',
      execute: (intentId, signal) => productClient.putReportSchedule(
        series.id, input, schedule ? etag(schedule.resourceRevision) : undefined, mutationOptions(intentId, signal),
      ),
    })
  }, [series, schedule, run])

  const deleteSchedule = useCallback(() => {
    if (!series) return Promise.resolve(false)
    return run({
      intentId: intent('delete-report-schedule'),
      busyLabel: 'Removing the schedule',
      doneLabel: 'Schedule removed',
      execute: (intentId, signal) => productClient.deleteReportSchedule(
        series.id, schedule ? etag(schedule.resourceRevision) : undefined, mutationOptions(intentId, signal),
      ),
    })
  }, [series, schedule, run])

  const putMember = useCallback((subjectId: string, body: ReportMemberMutation) => {
    if (!series) return Promise.resolve(false)
    return run({
      intentId: intent('put-report-member'),
      busyLabel: 'Saving the collaborator',
      doneLabel: 'Collaborator saved',
      execute: (intentId, signal) => productClient.putReportMember(series.id, subjectId, body, etag(series.policyRevision), mutationOptions(intentId, signal)),
    })
  }, [series, run])

  const removeMember = useCallback((subjectId: string) => {
    if (!series) return Promise.resolve(false)
    return run({
      intentId: intent('delete-report-member'),
      busyLabel: 'Removing the collaborator',
      doneLabel: 'Collaborator removed',
      execute: (intentId, signal) => productClient.deleteReportMember(series.id, subjectId, etag(series.policyRevision), mutationOptions(intentId, signal)),
    })
  }, [series, run])

  /** Retry the parked intent verbatim (transport_error → unknown). */
  const retryPending = useCallback(() => {
    const pending = pendingRef.current
    if (pending) void run(pending)
  }, [run])

  /** Abandon the parked intent and refresh so a fresh action starts clean. */
  const startNewPending = useCallback(() => {
    const pending = pendingRef.current
    if (pending) {
      productClient.abandonReportManageIntent(pending.intentId)
      pendingRef.current = null
    }
    void load().then(() => {
      setOp('stale')
      setMessage('The digest was refreshed. Review it before starting the change again.')
    })
  }, [load])

  const dismissOp = useCallback(() => { setOp('idle'); setMessage('Digest') }, [])

  return {
    series, issues, issuesCursor, schedule, members, status, op, message,
    loadingMore, moreError,
    load, loadMoreIssues, retryPending, startNewPending, dismissOp,
    createIssue, patchIssue, deleteIssue, publishIssue, withdrawIssue,
    patchSeries, archiveSeries, putSchedule, deleteSchedule, putMember, removeMember,
  }
}
