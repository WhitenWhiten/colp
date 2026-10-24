import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { AutomationJob, AutomationRule, AutomationRun, AutomationRunOncePreview } from '../../api/automationTypes'
import { JOB_STATUS } from './copy'
import { errorMessage, useAutomationDeps, useLoad } from './shared'
import { runPath } from './paths'

/** A real, single-bookmark task run; never interprets pairing as execution evidence. */
export function AgentTest({ rule, connected, onVerified }: { rule: AutomationRule; connected: boolean; onVerified: () => void }) {
  const { api, folders } = useAutomationDeps()
  const [search, setSearch] = useSearchParams()
  const resumeId = search.get('agentTest')
  const collectionId = rule.definition.scope.collectionId ?? ''
  const bookmarks = useLoad(`test-bookmarks:${collectionId}`, signal => folders.listBookmarks?.(collectionId, signal) ?? Promise.resolve([]))
  const tree = useLoad(`test-root:${collectionId}`, signal => folders.loadFolders(collectionId, signal))
  const [nodeId, setNodeId] = useState('')
  const [run, setRun] = useState<AutomationRun | null>(null)
  const [jobs, setJobs] = useState<AutomationJob[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const runId = run?.id
  const preview = useRef<AutomationRunOncePreview | null>(null)
  const attempt = useRef(crypto.randomUUID())
  const mounted = useRef(true)
  const verifiedCallback = useRef(onVerified)
  verifiedCallback.current = onVerified
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const choices = bookmarks.state.status === 'ready' ? bookmarks.state.data : []
  const selected = nodeId || choices[0]?.id || ''
  const canRestart = run?.status === 'cancelled' || (jobs.length > 0
    && jobs.every(item => ['failed', 'blocked', 'stale', 'review', 'cancelled', 'succeeded'].includes(item.status))
    && jobs.some(item => item.status !== 'succeeded'))

  useEffect(() => {
    if (!resumeId) return
    const controller = new AbortController()
    void api.getRun(resumeId, controller.signal).then(saved => {
      if (!controller.signal.aborted && saved.ruleId === rule.id && saved.ruleRevision === rule.revision) setRun(saved)
    }).catch(error => {
      if (!controller.signal.aborted) setNotice(errorMessage(error, 'Could not restore the previous test.'))
    })
    return () => controller.abort()
  }, [api, resumeId, rule.id, rule.revision])

  useEffect(() => {
    if (!runId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const started = Date.now()
    const refresh = async () => {
      try {
        const latest = await api.getRun(runId, controller.signal)
        const children = await Promise.all((latest.childRunIds ?? []).map(id => api.getRun(id, controller.signal)))
        const ids = [...new Set([latest, ...children].flatMap(item => item.jobIds))]
        const tasks = await Promise.all(ids.map(id => api.getJob(id, controller.signal)))
        if (controller.signal.aborted) return
        setRun(latest); setJobs(tasks)
        if (tasks.length === rule.definition.tasks.length && tasks.every(job => job.status === 'succeeded')) {
          setNotice('Test completed. Review the result before turning on this rule.')
          verifiedCallback.current()
          return
        }
        if (tasks.some(job => ['failed', 'blocked', 'cancelled', 'uncertain', 'review', 'stale'].includes(job.status))) {
          setNotice('The test needs attention. Open the run for the reason and recovery options.')
          return
        }
        if (latest.status === 'cancelled') { setNotice('Test cancelled.'); return }
        if (Date.now() - started > 30_000 && tasks.every(job => ['ready', 'pending'].includes(job.status)))
          setNotice('The AI has not picked up this test. Ask it to check your COLP automations, or paste the task request into it; pairing alone does not start background execution.')
      } catch (error) {
        if (!controller.signal.aborted) setNotice(errorMessage(error, 'Could not check the test. Retrying.'))
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3_000)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, runId, rule.definition.tasks.length])

  async function test() {
    if (!selected || tree.state.status !== 'ready') return
    setBusy(true); setNotice(null)
    try {
      if (!preview.current) preview.current = await api.previewRunOnce(rule.id, {
        folder: { serverUuid: await folders.serverUuid(), collectionId, nodeId: tree.state.data.rootId },
        includeDescendants: true, moveFolderedBookmarks: false, tasks: 'all', nodeId: selected, tasksOnly: true,
      }, attempt.current)
      if (!preview.current.canStart) {
        preview.current = null
        setNotice('This bookmark must match the rule, and the AI must be connected before the test can start.')
        return
      }
      const result = await api.startRunOnce(rule.id, { previewId: preview.current.id, previewDigest: preview.current.previewDigest })
      if (mounted.current) {
        setRun(result)
        setSearch(previous => { const next = new URLSearchParams(previous); next.set('agentTest', result.id); return next }, { replace: true })
      }
    } catch (error) {
      if (mounted.current) setNotice(errorMessage(error, 'Could not start the test. Retry to recover the same request.'))
    } finally { if (mounted.current) setBusy(false) }
  }

  return <section className="automation-agent-test" aria-label="Test this AI">
    <div className="field"><label htmlFor="automation-test-bookmark">Try one bookmark</label>
      <select id="automation-test-bookmark" value={selected} disabled={Boolean(run) || busy}
        onChange={event => { setNodeId(event.target.value); preview.current = null; attempt.current = crypto.randomUUID(); setNotice(null) }}>
        {!choices.length && <option value="">{bookmarks.state.status === 'loading' ? 'Loading bookmarks…' : 'Save a matching bookmark first'}</option>}
        {choices.map(bookmark => <option key={bookmark.id} value={bookmark.id}>{bookmark.title}</option>)}
      </select>
    </div>
    <p className="field-hint">Runs the selected AI tasks on this bookmark. Its folder stays the same; proposed changes wait for your approval.</p>
    {!run && <button type="button" className="btn btn-secondary" disabled={!connected || !selected || busy} onClick={() => void test()}>{busy ? 'Starting test…' : 'Test on this bookmark'}</button>}
    {(bookmarks.state.status === 'error' || tree.state.status === 'error') && <p role="alert">Could not load test bookmarks. <button type="button" className="btn btn-ghost btn-sm" onClick={() => { bookmarks.reload(); tree.reload() }}>Try again</button></p>}
    {run && <div role="status">
      {!jobs.length && <p>Waiting for agent tasks…</p>}
      {jobs.map(job => <p key={job.id}>{JOB_STATUS[job.status].label}{job.status === 'awaitingApproval' && <> · <Link to={job.planId ? `/approvals/${encodeURIComponent(job.planId)}` : '/approvals'} target="_blank" rel="noreferrer">Review result</Link></>}</p>)}
      <Link to={runPath(run.id)} target="_blank" rel="noreferrer">View test and results</Link>
      {canRestart && <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
        setRun(null); setJobs([]); setNotice(null); preview.current = null; attempt.current = crypto.randomUUID()
        setSearch(previous => { const next = new URLSearchParams(previous); next.delete('agentTest'); return next }, { replace: true })
      }}>Choose another test</button>}
      {['running', 'waiting'].includes(run.status) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void api.cancelRun(run.id, run.revision).then(setRun).catch(error => setNotice(errorMessage(error, 'Could not cancel the test.')))}>Cancel test</button>}
    </div>}
    {notice && <p className="field-hint" role="status">{notice}</p>}
  </section>
}
