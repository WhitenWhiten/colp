import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

export function ScrollProgress() {
  const { pathname } = useLocation()
  const [p, setP] = useState(0)
  const [seenPath, setSeenPath] = useState(pathname)
  if (seenPath !== pathname) {
    setSeenPath(pathname)
    setP(0)
  }

  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement
      const max = el.scrollHeight - el.clientHeight
      setP(max > 0 ? (el.scrollTop / max) * 100 : 0)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [pathname])

  return <div className="scroll-progress" data-testid="scroll-progress" style={{ ['--progress' as string]: `${p / 100}` }} aria-hidden />
}
