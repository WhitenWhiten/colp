import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { AutomationRunOnceInput, AutomationRunOncePreview, AutomationRunOnceSampleItem } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { useToast } from '../../components/AppToast'
import { Breadcrumb } from '../../components/Breadcrumb'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge, type StatusTone } from '../../components/StatusBadge'
import { classifyRouteError } from '../../lib/classifyRouteError'
import { formatDateTime } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import { rulePath, runPath } from './paths'
import { RuleSentence } from './RuleSentence'
import { errorMessage, isStale, useAutomationDeps, useLoad } from './shared'
import { useAutomationNames } from './useAutomationNames'

/* AU-25: run a rule once over bookmarks already saved in its collection.
   The owner picks a folder and options, previews the exact selection, and
   starts that stored preview by its id and digest, nothing else. Changing
   any option throws the preview away, and Start is offered only beside a
   current preview the server says can start. The server picks the members,
   batches and runs them; this page only shows its counts. */

type Options = {
  folderId: string
  includeDescendants: boolean
  moveFolderedBookmarks: boolean
  tasks: AutomationRunOnceInput['tasks']
}

const DEFAULT_OPTIONS: Options = { folderId: '', includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none' }

const DECISION: Record<AutomationRunOnceSampleItem['decision'], { label: string; tone: StatusTone }> = {
  matched: { label: 'Matches', tone: 'success' },
  explicitChoice: { label: 'Stays put', tone: 'neutral' },
  blocked: { label: 'Can’t be filed', tone: 'warning' },
  notMatched: { label: 'Doesn’t match', tone: 'muted' },
}

/** Why the server won't start this preview, read off its counts; the server decided. */
function startBlocker(preview: AutomationRunOncePreview, paused: boolean, tasks: Options['tasks']): string {
  const limit = preview.maxMembers.toLocaleString()
  if (preview.matchedCount + preview.blockedCount >= preview.maxMembers) {
    return `That’s more than ${limit} bookmarks for one run. Choose a smaller folder, or leave out its subfolders.`
  }
  if (preview.matchedCount === 0) return 'Nothing here matches the rule, so there is nothing to run on.'
  if (preview.blockedCount > 0) {
    return `${plural(preview.blockedCount, 'bookmark')} can’t be filed as things stand, so the run can’t start. Choose another folder, or fix the rule and preview again.`
  }
  if (paused) return 'All automations are paused. Resume them, then preview again.'
  return tasks === 'all'
    ? 'The agent work this rule asks for isn’t available right now. Choose File only, or check its workers on Agents.'
    : `This can’t start as previewed. The folder may hold more than ${limit} bookmarks; try a smaller one.`
}

/** What a refused start means for the owner, by the server's code. */
function startRefusal(error: unknown): string {
  if (error instanceof ProductApiError) {
    if (error.status === 0 || error.status >= 500 || error.status === 408 || error.status === 429) {
      return 'The server didn’t confirm the start. Start again: it repeats the same request, so it won’t run twice.'
    }
    if (error.code === 'automation_paused') return 'All automations are paused. Resume them, then start.'
    if (error.code === 'automation_command_conflict') {
      return 'This needs more runs than the rule has left today. Start again once its daily allowance resets, or choose fewer bookmarks.'
    }
    if (error.code === 'payload_too_large') return 'Your collection’s history is full, so these moves couldn’t be kept for Undo. Nothing was moved.'
  }
  return errorMessage(error, 'Could not start this run.')
}

export function RunOnce() {
  const { ruleId = '' } = useParams<{ ruleId: string }>()
  const navigate = useNavigate()
  const { success, error: toastError } = useToast()
  const { api, folders } = useAutomationDeps()
  const rule = useLoad(`rule:${ruleId}`, (signal) => api.getRule(ruleId, signal))
  const pause = useLoad('pause', (signal) => api.getPause(signal))
  const current = rule.state.status === 'ready' ? rule.state.data : null
  const names = useAutomationNames(current ? [current] : null)
  // A run-once works in the rule's own collection; the server refuses any other.
  const collectionId = current?.definition.scope.collectionId ?? ''
  const tree = useLoad(collectionId ? `folders:${collectionId}` : null, (signal) => folders.loadFolders(collectionId, signal))
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS)
  const [preview, setPreview] = useState<AutomationRunOncePreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'start' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const loaded = tree.state.status === 'ready' && tree.state.data.collectionId === collectionId ? tree.state.data : null
  // Start from the whole collection: its top level and everything under it.
  const rootId = loaded?.rootId ?? null
  useEffect(() => {
    if (rootId) setOptions((value) => (value.folderId ? value : { ...value, folderId: rootId }))
  }, [rootId])

  // A preview stops counting the moment it expires; render again then.
  useEffect(() => {
    if (!preview) return
    const left = Date.parse(preview.expiresAt) - Date.now()
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, left) + 50, 2_147_000_000))
    return () => clearTimeout(timer)
  }, [preview])

  if (rule.state.status === 'error') {
    const kind = classifyRouteError(rule.state.error)
    return (
      <PageShell>
        <RouteState
          kind={kind}
          icon="compass"
          titleAs="h1"
          title={kind === 'unavailable' ? 'This rule is not available' : undefined}
          description={kind === 'unavailable' ? 'It may belong to another account, or automations are off on this server.' : undefined}
          feature="Automations"
          onRetry={rule.reload}
        />
      </PageShell>
    )
  }
  if (!current) {
    return <PageShell><RouteState kind="loading" loadingLabel="Loading rule…" /></PageShell>
  }

  const shown = current
  const name = shown.definition.name
  if (!collectionId || shown.desiredState === 'archived') {
    return (
      <PageShell>
        <EmptyState
          icon="folder"
          titleAs="h1"
          title={shown.desiredState === 'archived' ? 'This rule is archived' : 'This rule has no collection to run in'}
          description={shown.desiredState === 'archived'
            ? 'An archived rule can’t run. Its past runs stay on its page.'
            : 'Edit the rule to choose where it files bookmarks, then run it once.'}
          action={<Link className="btn btn-secondary btn-sm" to={rulePath(shown.id)}>Back to “{name}”</Link>}
        />
      </PageShell>
    )
  }

  const hasTasks = shown.definition.tasks.length > 0
  const collectionTitle = names.collectionTitle(collectionId)
  const destination = names.ruleFolder(shown)
  const expired = preview !== null && Date.parse(preview.expiresAt) <= now
  const paused = pause.state.status === 'ready' && pause.state.data.paused
  const startable = preview !== null && preview.canStart && !expired ? preview : null
  const canPreview = Boolean(loaded && options.folderId) && busy === null
  const staying = preview?.explicitChoiceCount ?? 0

  /** Any change to what is selected throws the old preview away: only a previewed selection can start. */
  function change(patch: Partial<Options>) {
    setOptions((value) => ({ ...value, ...patch }))
    setPreview(null)
    setNotice(null)
  }

  async function runPreview() {
    if (!canPreview) return
    setBusy('preview')
    setNotice(null)
    try {
      const serverUuid = await folders.serverUuid()
      const result = await api.previewRunOnce(shown.id, {
        folder: { serverUuid, collectionId, nodeId: options.folderId },
        includeDescendants: options.includeDescendants,
        moveFolderedBookmarks: options.moveFolderedBookmarks,
        tasks: hasTasks ? options.tasks : 'none',
      }, crypto.randomUUID())
      setPreview(result)
      setNow(Date.now())
    } catch (error) {
      if (error instanceof ProductApiError && error.code === 'automation_paused') pause.reload()
      toastError(errorMessage(error, 'Could not preview this run.'))
    } finally {
      setBusy(null)
    }
  }

  async function start() {
    if (!startable || busy !== null) return
    setBusy('start')
    try {
      // Only the preview's identity goes up; the server starts what it stored.
      const run = await api.startRunOnce(shown.id, { previewId: startable.id, previewDigest: startable.previewDigest })
      success(run.status === 'completed'
        ? `Ran “${name}” once. Each bookmark’s change is on the run.`
        : `Started “${name}”. A larger run keeps going in the background; its page shows progress.`)
      navigate(runPath(run.id))
    } catch (error) {
      if (isStale(error)) {
        setPreview(null)
        setNotice('Your bookmarks or the rule changed since this preview, or it expired. Preview again, then start.')
      } else {
        if (error instanceof ProductApiError && error.code === 'automation_paused') pause.reload()
        toastError(startRefusal(error))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell data-testid="automation-run-once">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={<Breadcrumb items={[{ label: 'Automations', to: '/automations' }, { label: name, to: rulePath(shown.id) }, { label: 'Run once' }]} />}
        title="Run once"
        documentTitle={`Run ${name} once`}
        lede="Use this rule on bookmarks you already have. Preview exactly which ones it takes; nothing changes until you start that preview."
      />

      <div className="automation-editor">
        <div className="automation-editor-main">
          <div className="automation-form">
            <ol className="automation-steps">
              <li className="automation-step" aria-labelledby="run-once-where">
                <div className="automation-step-head">
                  <span className="automation-step-index" aria-hidden>1</span>
                  <h2 id="run-once-where">Which bookmarks</h2>
                </div>
                <div className="field">
                  <label htmlFor="run-once-folder">Folder in {collectionTitle ?? 'this collection'}</label>
                  <select
                    id="run-once-folder"
                    value={options.folderId}
                    disabled={!loaded || busy !== null}
                    onChange={(event) => change({ folderId: event.target.value })}
                  >
                    {!loaded && <option value="">{tree.state.status === 'error' ? 'Folders unavailable' : 'Loading folders…'}</option>}
                    {loaded && <option value={loaded.rootId}>Top level</option>}
                    {loaded?.folders.map((entry) => <option key={entry.id} value={entry.id}>{entry.path}</option>)}
                  </select>
                </div>
                {tree.state.status === 'error' && (
                  <p className="field-error" role="alert">{errorMessage(tree.state.error, 'Could not load the folders of this collection.')}</p>
                )}
                <fieldset className="option-group" disabled={busy !== null}>
                  <legend className="visually-hidden">Which bookmarks</legend>
                  <label className="option-row">
                    <input type="checkbox" checked={options.includeDescendants} onChange={(event) => change({ includeDescendants: event.target.checked })} />
                    <span>
                      <strong>Include its subfolders</strong>
                      <span className="automation-meta">Off takes only the bookmarks directly in this folder.</span>
                    </span>
                  </label>
                  <label className="option-row">
                    <input type="checkbox" checked={options.moveFolderedBookmarks} onChange={(event) => change({ moveFolderedBookmarks: event.target.checked })} />
                    <span>
                      <strong>Also move bookmarks already in a folder</strong>
                      <span className="automation-meta">Off by default: a folder you chose counts as your choice, and those bookmarks stay.</span>
                    </span>
                  </label>
                </fieldset>
              </li>

              {hasTasks && (
                <li className="automation-step" aria-labelledby="run-once-tasks">
                  <div className="automation-step-head">
                    <span className="automation-step-index" aria-hidden>2</span>
                    <h2 id="run-once-tasks">Agent tasks</h2>
                  </div>
                  <fieldset className="option-group" disabled={busy !== null}>
                    <legend className="visually-hidden">Agent tasks</legend>
                    <label className="option-row">
                      <input type="radio" name="run-once-tasks" checked={options.tasks === 'none'} onChange={() => change({ tasks: 'none' })} />
                      <span>
                        <strong>File only</strong>
                        <span className="automation-meta">No agent work and no cost.</span>
                      </span>
                    </label>
                    <label className="option-row">
                      <input type="radio" name="run-once-tasks" checked={options.tasks === 'all'} onChange={() => change({ tasks: 'all' })} />
                      <span>
                        <strong>File and run its agent tasks</strong>
                        <span className="automation-meta">Each bookmark counts as a run against the rule’s daily allowance.</span>
                      </span>
                    </label>
                  </fieldset>
                </li>
              )}
            </ol>
          </div>
        </div>

        <aside className="automation-editor-side automation-review" aria-label="Preview and start">
          <section className="automation-summary" aria-labelledby="run-once-rule-heading">
            <h2 id="run-once-rule-heading" className="automation-panel-title">This rule</h2>
            <RuleSentence
              rule={shown}
              collectionTitle={collectionTitle ?? null}
              folder={destination}
            />
          </section>

          <section
            className="automation-preview"
            aria-labelledby="run-once-preview-heading"
            aria-busy={busy === 'preview'}
            data-state={preview ? (expired ? 'stale' : 'current') : 'empty'}
            data-testid="run-once-preview"
          >
            <div className="automation-preview-head">
              <h2 id="run-once-preview-heading" className="automation-panel-title">Preview</h2>
              {preview && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={!canPreview} onClick={() => void runPreview()}>
                  <Icon name="refresh" />
                  {busy === 'preview' ? 'Previewing…' : 'Preview again'}
                </button>
              )}
            </div>
            {notice && <p className="automation-preview-stale" role="status">{notice}</p>}
            {!preview && (
              <>
                {!notice && (
                  <p className="automation-preview-lede">
                    See exactly which bookmarks this takes, as they are now. A preview changes nothing.
                  </p>
                )}
                <button type="button" className="btn btn-secondary btn-sm" disabled={!canPreview} onClick={() => void runPreview()}>
                  {busy === 'preview' ? 'Previewing…' : 'Preview'}
                </button>
              </>
            )}
            {preview && (
              <>
                {expired && (
                  <p className="automation-preview-stale" role="status" data-testid="run-once-expired">
                    This preview expired. Preview again to start.
                  </p>
                )}
                <ul className="automation-preview-stats" aria-label="Preview totals">
                  <li data-outcome="matched">
                    <span className="automation-preview-stat">{preview.matchedCount.toLocaleString()}</span>
                    <span className="automation-preview-stat-label">match the rule</span>
                  </li>
                  {staying > 0 && (
                    <li data-outcome="explicitChoice">
                      <span className="automation-preview-stat">{staying.toLocaleString()}</span>
                      <span className="automation-preview-stat-label">of those stay where you put them</span>
                    </li>
                  )}
                  {preview.blockedCount > 0 && (
                    <li data-outcome="blocked">
                      <span className="automation-preview-stat">{preview.blockedCount.toLocaleString()}</span>
                      <span className="automation-preview-stat-label">can’t be filed</span>
                    </li>
                  )}
                </ul>
                {preview.sample.length > 0 && (
                  <details className="automation-preview-group" open>
                    <summary>
                      <Icon name="chevron-right" className="automation-disclosure-chevron" />
                      <span className="automation-sample-title">A sample</span>
                      <span className="automation-preview-count">{plural(preview.sample.length, 'bookmark')}</span>
                    </summary>
                    <ul className="automation-preview-lines automation-sample" data-testid="run-once-sample">
                      {preview.sample.map((item) => {
                        const decision = DECISION[item.decision]
                        return (
                          <li key={item.nodeId} data-decision={item.decision}>
                            <span>{item.title || 'Untitled'}</span>
                            <StatusBadge tone={decision.tone}>{decision.label}</StatusBadge>
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                )}
                {!expired && !preview.canStart && (
                  <p className="automation-preview-note" data-testid="run-once-blocker">{startBlocker(preview, paused, options.tasks)}</p>
                )}
                {!expired && (
                  <p className="automation-meta">
                    Nothing has changed yet. This preview holds until <time dateTime={preview.expiresAt}>{formatDateTime(preview.expiresAt)}</time>.
                  </p>
                )}
              </>
            )}
          </section>

          <div className="automation-editor-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="run-once-start"
              disabled={!startable || busy !== null}
              aria-describedby="run-once-start-hint"
              onClick={() => void start()}
            >
              {busy === 'start' ? 'Starting…' : startable ? `Start on ${plural(startable.matchedCount, 'bookmark')}` : 'Start'}
            </button>
            <Link className="btn btn-ghost" to={rulePath(shown.id)}>Cancel</Link>
            <p className="automation-meta automation-editor-hint" id="run-once-start-hint">
              {startable
                ? 'Starts exactly this preview. Moves happen right away; each one can be undone from the run.'
                : 'Preview the selection as it is now to start.'}
            </p>
          </div>
        </aside>
      </div>
    </PageShell>
  )
}
