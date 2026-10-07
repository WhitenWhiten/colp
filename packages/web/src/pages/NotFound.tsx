import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isSelfHostedPathEnabled } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePageMeta } from '../lib/usePageMeta'
import '../styles/not-found.css'

/* Full-bleed stage: three poster-size serif digits staggered across the
   middle, "404 / Page / Not / Found" pinned to the four corners, and a
   single sentence plus two text links along the bottom. */
export function NotFound() {
  const { pathname } = useLocation()
  const stageRef = useRef<HTMLDivElement>(null)

  useDocumentTitle('Page not found')
  usePageMeta({ canonicalPath: null, robots: 'noindex' }, 'Page not found — Know-N')

  /* Pointer parallax, kept deliberately slight: the stage publishes
     --nf-x/--nf-y (-1…1, eased toward the pointer in a rAF lerp) and each
     digit translates by its own depth. Under reduced motion or a coarse
     pointer nothing attaches — the digits hold their printed stagger. */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || typeof window.matchMedia !== 'function') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (!window.matchMedia('(pointer: fine)').matches) return

    let raf = 0
    let tx = 0
    let ty = 0
    let x = 0
    let y = 0

    const tick = () => {
      x += (tx - x) * 0.1
      y += (ty - y) * 0.1
      stage.style.setProperty('--nf-x', x.toFixed(3))
      stage.style.setProperty('--nf-y', y.toFixed(3))
      raf = Math.abs(tx - x) > 0.001 || Math.abs(ty - y) > 0.001
        ? requestAnimationFrame(tick)
        : 0
    }
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const onMove = (event: PointerEvent) => {
      const rect = stage.getBoundingClientRect()
      tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2
      ty = ((event.clientY - rect.top) / rect.height - 0.5) * 2
      kick()
    }
    const onLeave = () => {
      tx = 0
      ty = 0
      kick()
    }

    stage.addEventListener('pointermove', onMove, { passive: true })
    stage.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div className="not-found-stage" ref={stageRef} data-testid="not-found-page">
      <div className="not-found-foot">
        <h1 className="not-found-title">This page isn’t here.</h1>
        <p className="not-found-lede">
          Nothing lives at <code className="not-found-path" data-testid="not-found-path">{pathname}</code>
          {' '}— the link may be out of date.
        </p>
        <nav className="not-found-exits" aria-label="Start points">
          <Link className="not-found-exit" to="/" data-testid="not-found-exit">Back home</Link>
          {isSelfHostedPathEnabled('/explore') && (
            <>
              <span className="not-found-exit-sep" aria-hidden="true">·</span>
              <Link className="not-found-exit" to="/explore" data-testid="not-found-exit">Explore</Link>
            </>
          )}
        </nav>
      </div>

      <div aria-hidden="true">
        <span className="not-found-corner not-found-corner--tl" data-testid="not-found-corner">404</span>
        <span className="not-found-corner not-found-corner--tr" data-testid="not-found-corner">Page</span>
        <span className="not-found-corner not-found-corner--bl" data-testid="not-found-corner">Not</span>
        <span className="not-found-corner not-found-corner--br" data-testid="not-found-corner">Found</span>
      </div>

      <div className="not-found-digits" aria-hidden="true" data-testid="not-found-digits">
        <span className="not-found-digit not-found-digit--a" data-testid="not-found-digit">4</span>
        <span className="not-found-digit not-found-digit--b" data-testid="not-found-digit">0</span>
        <span className="not-found-digit not-found-digit--c" data-testid="not-found-digit">4</span>
      </div>
    </div>
  )
}
