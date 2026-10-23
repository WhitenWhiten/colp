import { useEffect, useRef, useState } from 'react'
import type { AutomationEvidence, AutomationRun, AutomationRunOutput } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { Icon } from '../../components/Icon'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { RouteState } from '../../components/RouteState'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDateTime, formatRelative } from '../../lib/formatDate'
import { refreshActivitySummary } from '../../lib/activityStatus'
import { errorMessage, isStale, useAutomationDeps } from './shared'

/* AU-24: the text a run wrote (digests, reviews, summaries), oldest first,
   exactly as stored. Text is untrusted and only ever rendered as text. Each
   output keeps its provenance: which worker wrote it, from which step, and
   the evidence it cites. Reading marks outputs read only up to the last one
   on screen, so a digest that lands meanwhile stays unread. */

const TEXT_TYPE: Record<AutomationRunOutput['output']['textType'], string> = {
  digest: 'Digest',
  review: 'Review',
  summary: 'Summary',
}

const EVIDENCE_KIND: Record<AutomationEvidence['kind'], string> = {
  source: 'Bookmark',
  model: 'Model',
  user: 'You',
  rule: 'Rule',
}

type Outputs =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; items: AutomationRunOutput[]; cursor: string | null; loadingMore: boolean }

function unavailable(error: unknown): boolean {
  return error instanceof ProductApiError && (error.status === 404 || error.code === 'resource_not_found')
}

function OutputCard({ output, worker }: { output: AutomationRunOutput; worker: string | null }) {
  const { textType, text, language, evidence } = output.output
  return (
    <article className="automation-output" data-output-id={output.id} data-text-type={textType}>
      <header className="automation-output-head">
        <StatusBadge tone="neutral">{TEXT_TYPE[textType]}</StatusBadge>
        <p className="automation-meta">
          Written by {worker ?? 'a worker'}
          {' · '}
          <time dateTime={output.createdAt} title={formatDateTime(output.createdAt)}>{formatRelative(output.createdAt)}</time>
          {' · '}
          <a href={`#job-${output.jobId}`}>from this step</a>
        </p>
      </header>
      {/* A text node, never markup: whatever the worker wrote stays inert. */}
      <div className="automation-output-text" lang={language} data-testid="automation-output-text">{text}</div>
      {evidence.length > 0 && (
        <details className="automation-output-sources">
          <summary>
            <Icon name="chevron-right" className="automation-disclosure-chevron" />
            {evidence.length === 1 ? '1 source' : `${evidence.length} sources`}
          </summary>
          <ul>
            {evidence.map((item, index) => (
              <li key={`${item.reference}-${index}`}>
                <span className="automation-source-kind">{EVIDENCE_KIND[item.kind]}</span>
                <code>{item.reference}</code>
                <time dateTime={item.observedAt} title={formatDateTime(item.observedAt)}>seen {formatRelative(item.observedAt)}</time>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  )
}

export function RunOutputs({
  run,
  onRunChanged,
}: {
  run: AutomationRun
  /** Re-read the run after its read state changed or went stale. */
  onRunChanged: () => void
}) {
  const { api } = useAutomationDeps()
  const [outputs, setOutputs] = useState<Outputs>({ status: 'loading' })
  const [workers, setWorkers] = useState<ReadonlyMap<string, string>>(new Map())
  const marked = useRef(new Set<string>())
  // "New" stays for this visit even after reading records it on the server.
  const [arrivedUnread, setArrivedUnread] = useState(run.unread)
  useEffect(() => {
    if (run.unread) setArrivedUnread(true)
  }, [run.unread])

  useEffect(() => {
    const controller = new AbortController()
    setOutputs({ status: 'loading' })
    api.listRunOutputs(run.id, {}, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setOutputs({ status: 'ready', items: page.items, cursor: page.nextCursor, loadingMore: false })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setOutputs(unavailable(error) ? { status: 'unavailable' } : { status: 'error', error })
      })
    return () => controller.abort()
  }, [api, run.id, run.outputCount])

  useEffect(() => {
    const controller = new AbortController()
    api.listTargets(null, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setWorkers(new Map(page.items.map((target) => [target.id, target.configuration.name])))
      })
      .catch(() => { /* provenance falls back to "a worker" */ })
    return () => controller.abort()
  }, [api])

  // Mark read through the last output on screen, once per output and run revision.
  const last = outputs.status === 'ready' ? outputs.items.at(-1)?.id ?? null : null
  useEffect(() => {
    if (!run.unread || !last) return
    const attempt = `${last}:${run.revision}`
    if (marked.current.has(attempt)) return
    marked.current.add(attempt)
    api.markRunRead(run.id, last, run.revision)
      .then(() => {
        onRunChanged()
        void refreshActivitySummary()
      })
      .catch((error: unknown) => {
        // A new output changed the run's revision: read it again, then mark through the same output.
        if (isStale(error)) onRunChanged()
      })
  }, [api, last, onRunChanged, run.id, run.revision, run.unread])

  async function more() {
    if (outputs.status !== 'ready' || !outputs.cursor) return
    const { items, cursor } = outputs
    setOutputs({ ...outputs, loadingMore: true })
    try {
      const page = await api.listRunOutputs(run.id, { cursor })
      setOutputs({ status: 'ready', items: [...items, ...page.items], cursor: page.nextCursor, loadingMore: false })
    } catch (error) {
      setOutputs(unavailable(error) ? { status: 'unavailable' } : { status: 'ready', items, cursor, loadingMore: false })
    }
  }

  return (
    <section className="automations-section" aria-labelledby="automation-run-outputs" id="outputs">
      <div className="automations-section-head">
        <h2 id="automation-run-outputs">What it wrote</h2>
        <span className="count-pill">{run.outputCount}</span>
        {arrivedUnread && <StatusBadge tone="accent" data-testid="automation-run-unread">New</StatusBadge>}
      </div>
      {outputs.status === 'loading' && <RouteState kind="loading" loadingLabel="Loading what it wrote…" />}
      {outputs.status === 'unavailable' && (
        <p className="automation-panel-text automation-empty-line" data-testid="automation-outputs-unavailable">
          The bookmarks this was written from are no longer available, so its text isn’t shown.
        </p>
      )}
      {outputs.status === 'error' && (
        <div className="automation-inline-error" role="alert">
          <p>{errorMessage(outputs.error, 'Could not load what this run wrote.')}</p>
        </div>
      )}
      {outputs.status === 'ready' && outputs.items.length === 0 && (
        <p className="automation-panel-text automation-empty-line">Nothing to show yet.</p>
      )}
      {outputs.status === 'ready' && outputs.items.length > 0 && (
        <div className="automation-outputs">
          {outputs.items.map((output) => (
            <OutputCard key={output.id} output={output} worker={workers.get(output.targetId) ?? null} />
          ))}
        </div>
      )}
      {outputs.status === 'ready' && outputs.cursor && (
        <LoadMoreButton loading={outputs.loadingMore} onClick={() => void more()}>Show more</LoadMoreButton>
      )}
    </section>
  )
}
