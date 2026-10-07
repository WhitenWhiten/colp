import { useState } from 'react'

function hashTone(title: string): 'a' | 'b' | 'c' {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) | 0
  return (['a', 'b', 'c'] as const)[Math.abs(hash) % 3]!
}

export function CoverFallback({ title, className }: { title: string; className?: string }) {
  const letter = title.trim().charAt(0).toUpperCase() || '·'
  const tone = hashTone(title)
  return (
    <div
      className={['cover-fallback', `cover-fallback--${tone}`, className].filter(Boolean).join(' ')}
      aria-hidden
      data-testid="cover-fallback"
    >
      {letter}
    </div>
  )
}

/** External cover: lazy, async decode, letter fallback on missing/error. */
export function CoverImage({
  src,
  title,
  className,
}: {
  src?: string | null
  title: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <CoverFallback title={title} className={className} />
  return (
    <img
      className={className}
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
