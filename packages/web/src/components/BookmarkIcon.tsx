import { useState, type ReactNode } from 'react'
import type { BookmarkIconSrc } from '../lib/bookmarkIcon'

export function BookmarkIcon({
  icon,
  letter,
  className,
  width = 18,
  height = 18,
}: {
  icon: BookmarkIconSrc
  letter: ReactNode
  className?: string
  width?: number
  height?: number
}) {
  const src = icon.kind === 'letter' ? null : icon.src
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) {
    return <>{letter}</>
  }
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  )
}
