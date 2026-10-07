import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Portal into <body> after the first client commit, never during it, so a
 *  server render (renderToString has no document) and the hydrating first
 *  paint both emit nothing. Unlike gating on `open`, this keeps a closing
 *  Modal mounted through its exit animation. */
export function BodyPortal({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  useEffect(() => { setReady(true) }, [])
  return ready ? createPortal(children, document.body) : null
}
