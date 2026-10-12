import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { agentsApi } from '../../api/agentsClient'
import { productClient, type OwnedCollectionListItem } from '../../api'
import { Icon, type IconName } from '../../components/Icon'
import { ProgressBar } from '../../components/ProgressBar'
import { productName } from '../../lib/edition'

const DISMISSED_KEY = 'colp.getStarted.dismissed'
const COMPLETED_KEY = 'colp.getStarted.completed'

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, '1')
  } catch {
    // A private window keeps the card for this visit only.
  }
}

/** Whether the desk should mount the checklist at all (cheap, synchronous). */
export function getStartedHidden(): boolean {
  return readFlag(DISMISSED_KEY) || readFlag(COMPLETED_KEY)
}

type StepId = 'collection' | 'bookmarks' | 'browser' | 'agent' | 'share'

type Step = {
  id: StepId
  icon: IconName
  title: string
  body: string
  to: string
  action: string
}

const STEPS: readonly Step[] = [
  { id: 'collection', icon: 'collection', title: 'Create a collection', body: 'Collections hold your folders and bookmarks.', to: '/library/new', action: 'New collection' },
  { id: 'bookmarks', icon: 'download', title: 'Bring in your bookmarks', body: 'Import the bookmarks file any browser exports.', to: '/import', action: 'Import' },
  { id: 'browser', icon: 'browser', title: 'Connect a browser', body: 'Keep browser folders and a collection in sync.', to: '/extension', action: 'Connect' },
  { id: 'agent', icon: 'terminal', title: 'Connect an AI agent', body: 'Let Claude Code or Codex tidy up, with your approval.', to: '/agents', action: 'Connect' },
  { id: 'share', icon: 'link', title: 'Share a collection', body: 'Publish one and send a friend the link.', to: '', action: 'Share' },
]

export type GetStartedProbes = {
  hasBrowser: (signal: AbortSignal) => Promise<boolean>
  hasAgent: (signal: AbortSignal) => Promise<boolean>
}

const defaultProbes: GetStartedProbes = {
  hasBrowser: async (signal) => {
    // Vitest replaces fetch with a guard; the default probe must not call it.
    if (import.meta.env.MODE === 'test') return false
    const status = await productClient.getSyncStatus({ signal, maxRetries: 0 })
    return status.replicas.length > 0 || status.devices.length > 0
  },
  hasAgent: async (signal) => (await agentsApi.listAgents(signal)).agents.length > 0,
}

/**
 * The first-week checklist, after Raindrop's and Linkwarden's onboarding:
 * five steps that tick themselves from what the server already knows,
 * one link each, and a progress meter. Hidden for good once every step is
 * done or the owner dismisses it (a per-browser convenience, localStorage).
 */
export function GetStarted({
  collections,
  shareTo,
  probes = defaultProbes,
}: {
  collections: readonly OwnedCollectionListItem[]
  /** Where "Share" goes: the first collection's settings sheet. */
  shareTo: string | null
  probes?: GetStartedProbes
}) {
  const [dismissed, setDismissed] = useState(false)
  const [browser, setBrowser] = useState(false)
  const [agent, setAgent] = useState(false)

  useEffect(() => {
    let controller: AbortController | undefined
    const refresh = () => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      const settle = (probe: Promise<boolean>, set: (value: boolean) => void) => {
        probe.then((value) => {
          if (!current.signal.aborted) set(value)
        }).catch(() => {
          // An unknown step keeps its last known state.
        })
      }
      settle(probes.hasBrowser(current.signal), setBrowser)
      settle(probes.hasAgent(current.signal), setAgent)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller?.abort()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [probes])

  const done: Record<StepId, boolean> = {
    collection: collections.length > 0,
    bookmarks: collections.some((item) => (item.bookmarkCount ?? 0) > 0),
    browser,
    agent,
    share: collections.some((item) => item.collection.visibility !== 'private'),
  }
  const doneCount = STEPS.filter((step) => done[step.id]).length
  const complete = doneCount === STEPS.length

  useEffect(() => {
    if (complete) writeFlag(COMPLETED_KEY)
  }, [complete])

  if (dismissed) return null

  return (
    <section className="get-started" aria-labelledby="get-started-title" data-testid="get-started">
      <div className="get-started-head">
        <div>
          <p className="section-label">{complete ? 'All set' : 'Get started'}</p>
          <h2 id="get-started-title">
            {complete ? `${productName()} is ready` : `Make ${productName()} yours`}
          </h2>
        </div>
        <div className="get-started-progress">
          <span className="get-started-count">{doneCount} of {STEPS.length}</span>
          <ProgressBar value={(doneCount / STEPS.length) * 100} className="p0-progress get-started-meter" label="Setup progress" />
        </div>
        <button
          type="button"
          className="get-started-dismiss"
          aria-label="Hide the setup checklist"
          onClick={() => {
            writeFlag(DISMISSED_KEY)
            setDismissed(true)
          }}
        >
          <Icon name="cross" />
        </button>
      </div>
      <ol className="get-started-steps">
        {STEPS.map((step) => {
          const isDone = done[step.id]
          const to = step.id === 'share' ? shareTo : step.to
          return (
            <li key={step.id} className="get-started-step" data-done={isDone || undefined}>
              <span className="get-started-mark" aria-hidden>
                <Icon name={isDone ? 'check' : step.icon} />
              </span>
              <div className="get-started-text">
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
              {isDone
                ? <span className="get-started-done">Done</span>
                : to
                  ? <Link to={to} className="btn btn-secondary btn-sm">{step.action}</Link>
                  : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
