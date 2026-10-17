import { useState, type ReactNode } from 'react'
import type { BookmarkIconSrc } from '../lib/bookmarkIcon'
import { imageLoadHints, markImageShown } from '../lib/shownImages'

export function BookmarkIcon({
  icon,
  letter,
  className,
  width = 16,
  height = 16,
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
      {...imageLoadHints(src)}
      referrerPolicy="no-referrer"
      onLoad={() => markImageShown(src)}
      onError={() => setFailedSrc(src)}
    />
  )
}
