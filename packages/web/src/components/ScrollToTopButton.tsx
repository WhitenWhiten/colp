import { useEffect, useState } from 'react'
import { useExitAnimation } from '../lib/useExitAnimation'
import { Icon } from './Icon'

export function ScrollToTopButton() {
  const [visible, setVisible] = useState(false)
  // Exit phase: fade back down when scrolling above the threshold instead
  // of vanishing in one frame.
  const { mounted, closing } = useExitAnimation(visible)

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > 400)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!mounted) return null

  return (
    <button
      type="button"
      className={`scroll-to-top-btn${closing ? ' is-closing' : ''}`}
      aria-label="Scroll to top"
      inert={closing || undefined}
      onClick={() => {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
      }}
    >
      <Icon name="chevron-up" />
    </button>
  )
}
