import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { CollectionCard } from '../components/CollectionCard'
import { DitherField } from '../components/DitherField'
import { Icon } from '../components/Icon'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { paintBandTexture, subscribeTokenChange } from '../lib/dither'
import { openSearchPalette } from '../lib/searchPaletteEvents'
import { searchShortcutLabel } from '../lib/shortcutLabel'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useExplorePreview } from '../lib/useExplorePreview'

const typewriterWords = [
  'collection.',
  'shared folder.',
  'reading path.',
  'team library.',
] as const

/** wordIndex is kept in range by the modulo below; the tuple type makes [0] total. */
function typewriterWord(index: number): string {
  return typewriterWords[index % typewriterWords.length] ?? typewriterWords[0]
}

/* Motion is JS-owned (M02) so the first paint can show a complete word (no
   layout shift) and the caret stays in sync. Each newly typed char gets a
   one-shot pixel pop, matching the dither field's stepped register. */
function TypewriterText({ paused, stopped }: {
  /** Covered by page content: skip the loop, keep the caret blinking. */
  paused: boolean
  /** The visitor paused the hero's motion: the caret stops too. */
  stopped: boolean
}) {
  const [wordIndex, setWordIndex] = useState(0)
  const [displayed, setDisplayed] = useState<string>(typewriterWords[0])
  const [isDeleting, setIsDeleting] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    /* WCAG 2.3.3: under reduced-motion the loop never starts — the title
       rests on the complete first word and only the caret keeps its
       (deliberately motion-exempt) cadence. */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // R15-30: nothing to animate while the page content covers the hero;
    // R15-38: or once the visitor has paused the motion.
    if (paused || stopped) return

    const word = typewriterWord(wordIndex)

    if (isPaused) {
      // Pause on a complete word — first paint and capture frames stay readable
      timeoutRef.current = setTimeout(() => {
        setIsPaused(false)
        setIsDeleting(true)
      }, 2200)
      return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }
    }

    if (!isDeleting) {
      if (displayed.length < word.length) {
        timeoutRef.current = setTimeout(() => {
          setDisplayed(word.slice(0, displayed.length + 1))
        }, 90 + Math.random() * 60)
      } else {
        setIsPaused(true)
      }
    } else if (displayed.length > 0) {
      timeoutRef.current = setTimeout(() => {
        setDisplayed(displayed.slice(0, -1))
      }, 40)
    } else {
      setIsDeleting(false)
      setWordIndex((prev) => (prev + 1) % typewriterWords.length)
    }

    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }
  }, [displayed, isDeleting, isPaused, paused, stopped, wordIndex])

  // Paused by the visitor: rest on the whole current word, without a caret.
  const shown = stopped ? typewriterWord(wordIndex) : displayed
  return (
    <span className="serif-em typewriter-wrap" data-testid="typewriter-wrap">
      {/* R15-39: an aria-label on a generic span is not reliably read. The
          heading's name comes from this stable copy of the first word; the
          typing itself is decoration. */}
      <span className="visually-hidden">{typewriterWord(0)}</span>
      <span className="typewriter-text" aria-hidden data-testid="typewriter-text">
        {[...shown].map((char, i) => (
          <span
            key={i}
            className={
              !stopped && !isPaused && !isDeleting && i === displayed.length - 1 ? 'typewriter-pop' : undefined
            }
          >
            {char === ' ' ? ' ' : char}
          </span>
        ))}
      </span>
      {stopped ? null : (
        <span className={`typewriter-cursor ${isPaused ? 'is-blinking' : ''}`} aria-hidden data-testid="typewriter-cursor">▮</span>
      )}
    </span>
  )
}

const HERO_LEAD = 'Your bookmarks already contain a'

const modes = [
  {
    title: 'Capture',
    detail:
      'Browser context preserved — the page title, address, and source metadata in one click.',
  },
  {
    title: 'Classify',
    detail:
      'Suggestions stay reversible. Accept, adjust, or ignore — the library learns your folders, not the other way around.',
  },
  {
    title: 'Connect',
    detail:
      'Board, list, and graph views over the same links. Reorganize without losing the thread.',
  },
  {
    title: 'Publish',
    detail:
      'Public or private. Share a collection as a reading path others can follow.',
  },
]

const extGlyphs = [
  <Icon key="capture" name="browser" />,
  <Icon key="sync" name="sync" />,
  <Icon key="embed" name="code" />,
  <Icon key="server" name="server" />,
]

/* R15-38: the visitor's choice to pause the hero motion, kept per browser. */
const MOTION_KEY = 'known.landing-motion'

function readMotionStopped(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) === 'paused'
  } catch {
    return false
  }
}

/**
 * R15-30: the sticky hero stays "intersecting" while .landing-content
 * scrolls over it, so an IntersectionObserver never pauses it. This reports
 * when the content's top edge has reached the hero's top: fully covered.
 */
function useHeroCovered(hero: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>) {
  const [covered, setCovered] = useState(false)
  useEffect(() => {
    let raf = 0
    const check = () => {
      raf = 0
      const heroBox = hero.current?.getBoundingClientRect()
      const contentTop = content.current?.getBoundingClientRect().top
      if (heroBox === undefined || contentTop === undefined) return
      // A hero with no box (not laid out) is never covered.
      setCovered(heroBox.height > 0 && contentTop <= heroBox.top + 1)
    }
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(check)
    }
    check()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [hero, content])
  return covered
}

export function Landing() {
  if (isSelfHostedEdition()) return <SelfHostedHome />
  return <CloudLanding />
}

/** A personal server has no marketing page: `/` opens the library or sign-in. */
function SelfHostedHome() {
  const { isLoggedIn, bootstrapping } = useAuth()
  if (bootstrapping) return null
  return <Navigate to={isLoggedIn ? '/library' : '/login'} replace />
}

function CloudLanding() {
  useDocumentTitle('Online bookmark library')
  const bandRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const heroCovered = useHeroCovered(heroRef, contentRef)
  const [motionStopped, setMotionStopped] = useState(readMotionStopped)
  const toggleMotion = () => {
    const next = !motionStopped
    setMotionStopped(next)
    try {
      if (next) localStorage.setItem(MOTION_KEY, 'paused')
      else localStorage.removeItem(MOTION_KEY)
    } catch { /* storage unavailable: the choice lasts this visit */ }
  }
  const { items: curated } = useExplorePreview(4)
  const liveCollectionTo = curated[0] ? `/c/${curated[0].slug}` : '/explore'

  /* Closing band: same accent tokens as the hero field, re-painted when
     tokens change so a theme switch cannot leave a stale bitmap. */
  useEffect(() => {
    const paint = () => {
      if (bandRef.current) paintBandTexture(bandRef.current)
    }
    paint()
    return subscribeTokenChange(paint)
  }, [])

  return (
    <>
      <section className="landing-hero" data-testid="landing-hero" ref={heroRef}>
        <div className="landing-hero-wipe">
          <DitherField paused={heroCovered || motionStopped} />
        </div>
        <div className="landing-hero-stage rise">
          <div className="landing-hero-copy">
            <h1 className="display display-lg landing-hero-title">
              {/* R15-39: plain text, so the heading reads as words, not letters. */}
              <span className="landing-hero-lead">{HERO_LEAD}</span>{' '}
              <span className="typewriter-line">
                <TypewriterText paused={heroCovered} stopped={motionStopped} />
              </span>
            </h1>
            {/* R12-13: the first viewport states the product shape in plain words. */}
            <p className="landing-hero-lede">
              An online bookmark library for saved links, synced browser folders and shared
              collections.
            </p>
            {/* R7-01 (accepted): the hero stays button-free by design. The sticky
                top nav already carries Log in + Get started on first paint, and the
                statement section / closing band own the in-page conversion points. */}
            <a className="landing-skip" href="#landing-content">
              See how it works
              <Icon name="chevron-down" />
            </a>
          </div>
        </div>
        <button type="button" className="landing-motion-toggle" onClick={toggleMotion}>
          {motionStopped ? 'Play animation' : 'Pause animation'}
        </button>
      </section>

      <div className="landing-content" id="landing-content" ref={contentRef}>
        <section className="landing-section landing-statement">
          <div className="landing-statement-inner">
            <p className="eyebrow">
              Online bookmark library
            </p>
            <p className="landing-statement-lede">
              {isSelfHostedEdition()
                ? 'COLP Server keeps your bookmarks on this server, with a library and browser sync.'
                : 'Know-N is an online bookmark library for saved links, shared collections, browser sync, and knowledge paths worth revisiting.'}
            </p>
            <div className="landing-hint" aria-label="Product shortcuts">
              <button type="button" className="landing-search-trigger" onClick={openSearchPalette}>
                Search anywhere with <kbd>{searchShortcutLabel()}</kbd>
              </button>
              <span className="landing-hint-sep" aria-hidden />
              {isSelfHostedPathEnabled('/explore') && (
                <Link className="landing-browse-link" to="/explore">
                  Explore collections{' '}
                  <span className="landing-external-arrow" aria-hidden>
                    <Icon name="arrow-right" />
                  </span>
                </Link>
              )}
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="landing-chapter-grid">
            <div className="landing-chapter-sticky">
              <p className="eyebrow">How it works</p>
              <h2 className="display display-sm">
                Four moves,
                <br />
                no busywork.
              </h2>
              <p className="lede">
                The library stays out of your way — capture in context, file with suggestions,
                arrange on your terms.
              </p>
              <div className="mini-card">
                <div className="mini-head">
                  <span className="mini-kicker">Interface Systems</span>
                  <span className="mini-title">A path through modern UI foundations</span>
                  <span className="mini-meta">42 bookmarks · by Mira Okada</span>
                </div>
                <div className="mini-row">
                  <span className="mini-dot mini-dot--github" aria-hidden />
                  <span className="mini-name">Radix Primitives</span>
                  <span className="mini-host">radix-ui.com</span>
                </div>
                <div className="mini-row">
                  <span className="mini-dot mini-dot--medium" aria-hidden />
                  <span className="mini-name">Container Queries</span>
                  <span className="mini-host">developer.mozilla.org</span>
                </div>
                <div className="mini-row">
                  <span className="mini-dot mini-dot--figma" aria-hidden />
                  <span className="mini-name">Spring Physics in UI</span>
                  <span className="mini-host">framer.com</span>
                </div>
                <div className="mini-row">
                  <span className="mini-dot mini-dot--arxiv" aria-hidden />
                  <span className="mini-name">Interface Systems vol. 3</span>
                  <span className="mini-host">arxiv.org</span>
                </div>
              </div>
            </div>
            <div className="landing-chapter-rows">
              {modes.map((mode, i) => (
                <div className="mode-row" key={mode.title}>
                  <span className="mode-index">{String(i + 1).padStart(2, '0')}</span>
                  <div className="mode-body">
                    <h3>{mode.title}</h3>
                    <p>{mode.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Extensibility</p>
              <h2 className="display display-sm">The library is a platform, not a silo.</h2>
            </div>
            <p className="lede">
              Capture from the browser, sync the bookmarks you already have, embed a collection,
              and read published collections with software.
            </p>
          </div>
          <div className="extensibility-grid" role="list" tabIndex={0} aria-label="Extensibility highlights">
            <div role="listitem">
              <Link to="/extension" className="panel panel-raised ext-card">
                <span className="ext-glyph" aria-hidden>
                  {extGlyphs[0]}
                </span>
                <div className="ext-header">Capture</div>
                <h3>Chromium extension</h3>
                <p>
                  One click saves the page, with its title and source, straight into the right
                  collection.
                </p>
                <div className="ext-foot">
                  <div className="ext-badges">
                    <span className="badge">Chrome</span>
                  </div>
                  <span className="ext-cta">Open extension</span>
                </div>
              </Link>
            </div>
            <div role="listitem">
              <Link to="/sync" className="panel panel-raised ext-card">
                <span className="ext-glyph" aria-hidden>
                  {extGlyphs[1]}
                </span>
                <div className="ext-header">Sync</div>
                <h3>Browser sync</h3>
                <p>
                  Two-way sync keeps your existing bookmarks and the library in step — no imports, no
                  exports, no drift.
                </p>
                <div className="ext-foot">
                  <div className="ext-badges">
                    <span className="badge">Two-way</span>
                  </div>
                  <span className="ext-cta">Open sync center</span>
                </div>
              </Link>
            </div>
            {isSelfHostedPathEnabled('/share') && <div role="listitem">
              <Link to="/share" className="panel panel-raised ext-card">
                <span className="ext-glyph" aria-hidden>
                  {extGlyphs[2]}
                </span>
                <div className="ext-header">Embed</div>
                <h3>Collection embeds</h3>
                <p>
                  Drop a live collection into any page. It stays in sync — curate once, publish
                  everywhere.
                </p>
                <div className="ext-foot">
                  <div className="ext-badges">
                    <span className="badge">iframe</span>
                  </div>
                  <span className="ext-cta">Open share and embed</span>
                </div>
              </Link>
            </div>}
            {isSelfHostedPathEnabled('/developers') && <div role="listitem">
              <Link to="/developers" className="panel panel-raised ext-card">
                <span className="ext-glyph" aria-hidden>
                  {extGlyphs[3]}
                </span>
                <div className="ext-header">Platform</div>
                <h3>Collection Protocol &amp; MCP</h3>
                <p>
                  Software can list and read published collections through the Collection Protocol
                  (COLP), and agents can connect over MCP.
                </p>
                <div className="ext-foot">
                  <div className="ext-badges">
                    <span className="badge">COLP</span>
                    <span className="badge">MCP</span>
                  </div>
                  <span className="ext-cta">Open developers</span>
                </div>
              </Link>
            </div>}
          </div>
        </section>

        {/* R15-23: during an outage (or with no public collections) the
            grid would be an empty band; show it only with cards. */}
        {curated.length > 0 && isSelfHostedPathEnabled('/explore') && (
          <section className="landing-section landing-collections-section">
            <div className="section-head">
              <div>
                <p className="eyebrow">Curated in public</p>
                <h2 className="display display-sm">Collections with a point of view</h2>
              </div>
              <Link to="/explore" className="btn btn-secondary btn-sm">
                Browse all collections
              </Link>
            </div>
            <div
              className="collection-grid landing-collection-grid"
              role="region"
              aria-label="Collections"
              tabIndex={0}
            >
              {curated.map((c) => (
                <CollectionCard key={c.id} c={c} namedTransition />
              ))}
            </div>
          </section>
        )}

        <section className="landing-section">
          <p className="landing-closing-serif serif-em">
            Bookmarks are better when they stay organized.
          </p>
          <div className="landing-closing-band" ref={bandRef}>
            <p className="eyebrow">Begin</p>
            <h2>Start your collection</h2>
            <p>Bring the links you already have. Build a collection worth revisiting.</p>
            <div className="cta-row landing-cta" data-testid="landing-cta">
              <Link to="/onboarding" className="btn btn-primary btn-lg">
                Start a collection
              </Link>
              <Link to={liveCollectionTo} className="btn btn-secondary btn-lg">
                Explore a live collection
              </Link>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
