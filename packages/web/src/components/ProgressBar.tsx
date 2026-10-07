type ProgressTone = 'success' | 'accent' | 'warning' | 'danger'

type ProgressBarProps = {
  /** 0–100; clamped defensively */
  value: number
  /** Track class — keeps each surface's existing bar styling */
  className?: string
  /** Semantic fill. Default track (`.p0-progress`) is already success. */
  tone?: ProgressTone
  /**
   * Accessible name. When provided the bar exposes role="progressbar"
   * with aria-value*; when omitted the bar is decorative (aria-hidden)
   * and the surrounding text must carry the number.
   */
  label?: string
}

/** Shared determinate progress bar: track div + inline-% fill span. */
export function ProgressBar({ value, className = 'p0-progress', tone, label }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value))
  const classes = [className, tone ? `p0-progress--${tone}` : ''].filter(Boolean).join(' ')
  const a11y = label
    ? {
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(pct),
        'aria-label': label,
      }
    : { 'aria-hidden': true }
  return (
    <div
      className={classes}
      style={{ ['--progress' as string]: String(pct / 100) }}
      {...a11y}
    >
      <span />
    </div>
  )
}
