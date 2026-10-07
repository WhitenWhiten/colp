import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'

type ClampedTextProps = {
  text: string
  /** Class on the clamped text element; the host stylesheet owns the line-clamp rule. */
  className: string
  /** Class on the wrapper, which carries [data-expanded] for the unclamp override. */
  wrapperClassName?: string
  toggleClassName?: string
  moreLabel?: string
  lessLabel?: string
  /** Extra attributes for the clamped text element (data hooks, ids). */
  textProps?: Omit<ComponentPropsWithoutRef<'p'>, 'className' | 'children' | 'ref'> & Record<`data-${string}`, string | undefined>
}

/* CSS-clamped text with an expand toggle that only renders when the text
   actually truncates. The full string stays in the DOM while clamped (screen
   readers, find-in-page); truncation is detected by comparing scroll/client
   height. While expanded we skip measuring — the unclamped element reports
   no overflow, which would collapse the toggle back. */
export function ClampedText({
  text,
  className,
  wrapperClassName,
  toggleClassName,
  moreLabel = 'Show more',
  lessLabel = 'Show less',
  textProps,
}: ClampedTextProps) {
  const textRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)

  /* R15-32: layout effect, so the first measurement (and the toggle it may
     add) lands before paint instead of pushing content down a frame later. */
  useLayoutEffect(() => {
    if (expanded) return
    const el = textRef.current
    if (!el) return
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, expanded])

  return (
    <div className={wrapperClassName} data-testid="clamped-text" data-expanded={expanded || undefined}>
      <p ref={textRef} className={className} dir="auto" {...textProps}>{text}</p>
      {truncated ? (
        <button
          type="button"
          className={toggleClassName}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      ) : null}
    </div>
  )
}
