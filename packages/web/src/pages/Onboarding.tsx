import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getExploreCollections, isProductApiError, productClient } from '../api'
import { useAuth } from '../auth/AuthContext'
import { mapExploreItem, type ExploreCard } from '../lib/mapExploreItem'
import { plural } from '../lib/plural'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { BrandName } from '../components/Brand'
import { LoadingState } from '../components/EmptyState'
import '../styles/auth-pages.css'

const LOGIN_HREF = `/login?returnTo=${encodeURIComponent('/onboarding')}`
const SELECTION_KEY = 'onboarding:follow-selection'
const SUGGESTION_LIMIT = 5

const steps = [
  {
    title: 'Get the browser extension',
    body: 'The extension syncs the bookmark folders you choose into collections you own. Install it whenever you like — signing in, picking folders, and sync itself all happen inside the extension.',
    cta: 'Continue',
  },
  {
    title: 'Follow popular collections',
    body: 'Collections are curated paths through a topic. Follow a few to seed your feed with trusted sources — or skip this and start with your own library.',
    cta: 'Finish',
  },
]

function readStashedSelection(): string[] {
  try {
    const raw = sessionStorage.getItem(SELECTION_KEY)
    const ids: unknown = raw === null ? null : JSON.parse(raw)
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return [] // storage unavailable — start with no picks
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError')
}

export function Onboarding() {
  useDocumentTitle('Onboarding')
  /* D-34: a signed-out visitor finishes by signing in; the picked collections
     ride through the login round-trip in sessionStorage so the board they
     chose is still selected when onboarding resumes. R15-36: the stash is
     kept until a signed-in finish (a remount before sign-in used to lose
     it), and restored picks start on the step that shows them. */
  const [restored] = useState(readStashedSelection)
  const [step, setStep] = useState(restored.length > 0 ? 1 : 0)
  const [suggestions, setSuggestions] = useState<ExploreCard[]>([])
  const [suggestionState, setSuggestionState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadNonce, setLoadNonce] = useState(0)
  const [selected, setSelected] = useState<string[]>(restored)
  const [followError, setFollowError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const navigate = useNavigate()
  const current = steps[step] ?? steps[0]!
  const signedIn = Boolean(isLoggedIn && user && !bootstrapping)

  const stepHeadingRef = useRef<HTMLHeadingElement>(null)
  const shownStep = useRef(step)

  const stashSelection = (ids: string[] = selected) => {
    try { sessionStorage.setItem(SELECTION_KEY, JSON.stringify(ids)) } catch { /* storage unavailable */ }
  }
  const clearStash = () => {
    try { sessionStorage.removeItem(SELECTION_KEY) } catch { /* storage unavailable */ }
  }

  /* R15-36: a step change replaces the card's content; move focus to the
     new step heading so it is announced (not on first render). */
  useEffect(() => {
    if (shownStep.current === step) return
    shownStep.current = step
    stepHeadingRef.current?.focus()
  }, [step])

  useEffect(() => {
    const controller = new AbortController()
    setSuggestionState('loading')
    void getExploreCollections(
      { sort: 'popular', limit: SUGGESTION_LIMIT },
      { signal: controller.signal },
    ).then(
      (page) => {
        if (controller.signal.aborted) return
        setSuggestions(page.items.map(mapExploreItem))
        setSuggestionState('ready')
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setSuggestions([])
        setSuggestionState('error')
      },
    )
    return () => controller.abort()
  }, [loadNonce])

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    setSelected(next)
    /* The finish may be a plain link to login: stash each pick as it is made
       so the selection survives the round-trip however the link is followed
       (click, middle-click, keyboard). Cleared on a signed-in finish. */
    stashSelection(next)
  }

  const finishFollow = async () => {
    if (bootstrapping || submitting) return
    if (!isLoggedIn || !user) {
      stashSelection()
      navigate(LOGIN_HREF)
      return
    }
    const picked = suggestions.filter((collection) => selected.includes(collection.id))
    if (picked.length === 0) {
      /* R7-02: following is optional seeding, not a gate. Finish lands on the
         library — the product's core surface — not the start-page board. */
      clearStash()
      navigate('/library')
      return
    }

    setSubmitting(true)
    setFollowError(null)
    const actorProfileId = user.profileId
    let failed = false
    let failureHint: string | null = null

    try {
      for (const collection of picked) {
        try {
          await productClient.followCollection(collection.id, {
            intentId: `collection-follow:${actorProfileId}:${collection.id}:follow`,
            maxRetries: 0,
          })
        } catch (error) {
          if (isAbortError(error)) return
          failed = true
          failureHint = isProductApiError(error)
            ? error.recoveryHint
            : 'Could not follow some collections. Try again.'
        }
      }

      if (failed) {
        setFollowError(failureHint ?? 'Could not follow some collections. Try again.')
        return
      }
      clearStash()
      navigate('/library')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="onboarding-page">
      <div className="onboarding-inner rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Getting started</p>
        <h1 className="display display-sm">Set up Know-N in two steps</h1>

        <div className="steps" aria-hidden>
          {steps.map((_, i) => (
            <div
              key={i}
              className={`step-dot ${i === step ? 'is-active' : ''} ${i < step ? 'is-done' : ''}`}
            />
          ))}
        </div>

        <div className="panel panel-raised onboard-card">
          <p className="meta">
            Step {step + 1} of {steps.length}
          </p>
          <h2 ref={stepHeadingRef} tabIndex={-1}>{current.title}</h2>
          <p>{current.body}</p>

          {step === 0 && (
            <div className="row">
              <Link to="/extension" className="btn btn-secondary">
                Get the extension
              </Link>
            </div>
          )}

          {step === 1 && (
            <>
              {suggestionState === 'loading' ? (
                <LoadingState label="Loading popular collections…" />
              ) : suggestionState === 'error' ? (
                <div className="pick-list">
                  <p className="field-error" role="alert">
                    Couldn't load collections right now.
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setLoadNonce((n) => n + 1)}
                  >
                    Try again
                  </button>
                </div>
              ) : suggestions.length === 0 ? (
                <p className="meta">
                  No public collections to suggest yet. You can browse Explore any time.
                </p>
              ) : (
                <div className="pick-list">
                  {suggestions.map((collection) => (
                    <button
                      key={collection.id}
                      type="button"
                      className="pick-item"
                      aria-pressed={selected.includes(collection.id)}
                      onClick={() => toggle(collection.id)}
                    >
                      <span className="avatar" aria-hidden>
                        {collection.title.trim().charAt(0).toUpperCase() || '?'}
                      </span>
                      <span>
                        <strong>{collection.title}</strong>
                        <span className="meta">
                          By {collection.curator} · {plural(collection.links, 'bookmark')}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {followError ? (
                <p className="field-error" role="alert">{followError}</p>
              ) : null}
            </>
          )}

          {/* Step 1 has nowhere to go back to: a greyed Back there read as a
              broken control. The empty span keeps Continue on the right. */}
          <div className="row row--between onboard-nav">
            {step > 0 ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                Back
              </button>
            ) : <span aria-hidden />}
            {step < steps.length - 1 ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep((s) => s + 1)}
              >
                {current.cta}
              </button>
            ) : bootstrapping ? (
              <button type="button" className="btn btn-primary" disabled>
                {current.cta}
              </button>
            ) : signedIn ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting || suggestionState === 'loading'}
                onClick={() => {
                  void finishFollow()
                }}
              >
                {current.cta}
              </button>
            ) : (
              <Link to={LOGIN_HREF} className="btn btn-primary">
                Sign in to finish
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
