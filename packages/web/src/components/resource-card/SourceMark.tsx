import type { SourceType } from '../../types/catalog'
import { isDottedSource } from '../../lib/sources'
import { Icon } from '../Icon'

/**
 * Source mark glyph shown in the card head (C03).
 * Pure function of the source type; returns null when the type has no
 * mark (dotted sources render `.source-dot` via the palette token).
 */
export function SourceMark({ type }: { type: SourceType }) {
  if (type === 'figma') {
    return (
      <span className="figma-mark" aria-hidden data-testid="figma-mark">
        <i /><i /><i /><i /><i />
      </span>
    )
  }
  if (type === 'producthunt') {
    return <span className="ph-mark" aria-hidden>P</span>
  }
  if (type === 'arxiv') {
    return <span className="arxiv-wordmark">arXiv</span>
  }
  if (type === 'npm') {
    return <span className="npm-mark" aria-hidden>npm</span>
  }
  if (type === 'huggingface') {
    return <span className="hf-mark" aria-hidden>HF</span>
  }
  if (type === 'notion') {
    return <span className="notion-mark" aria-hidden>N</span>
  }
  if (type === 'stackoverflow') {
    return <span className="so-mark" aria-hidden />
  }
  if (type === 'codepen') {
    return <span className="codepen-mark" aria-hidden />
  }
  if (type === 'dribbble') {
    return <span className="dribbble-mark" aria-hidden />
  }
  if (type === 'nature') {
    return <span className="nature-mark" aria-hidden>N</span>
  }
  if (type === 'acm') {
    return <span className="acm-mark" aria-hidden>ACM</span>
  }
  if (type === 'ted') {
    return <span className="ted-mark" aria-hidden>TED</span>
  }
  if (type === 'collectionlist') {
    return <span className="collist-mark" aria-hidden><Icon name="lines" /></span>
  }
  if (type === 'search') {
    return <span className="desk-mark" aria-hidden><Icon name="search" /></span>
  }
  if (type === 'sticky') {
    return <span className="desk-mark desk-mark-sticky" aria-hidden><Icon name="pencil" /></span>
  }
  if (type === 'todo') {
    return <span className="desk-mark desk-mark-todo" aria-hidden><Icon name="check" /></span>
  }
  if (type === 'weather') {
    return <span className="desk-mark desk-mark-weather" aria-hidden><Icon name="sun" /></span>
  }
  if (type === 'pomodoro') {
    return <span className="desk-mark desk-mark-pomo" aria-hidden><Icon name="timer" /></span>
  }
  if (type === 'clock') {
    return <span className="desk-mark desk-mark-clock" aria-hidden><Icon name="clock" /></span>
  }
  if (type === 'quicklinks') {
    return <span className="desk-mark desk-mark-links" aria-hidden><Icon name="arrow-up-right" /></span>
  }
  if (type === 'habits') {
    return <span className="desk-mark desk-mark-habits" aria-hidden><Icon name="check-circle" /></span>
  }
  if (type === 'reading') {
    return <span className="desk-mark desk-mark-reading" aria-hidden><Icon name="book" /></span>
  }
  if (type === 'ssh') {
    return <span className="desk-mark desk-mark-ssh" aria-hidden><Icon name="terminal" /></span>
  }
  if (type === 'ghheatmap') {
    return <span className="desk-mark desk-mark-heatmap" aria-hidden><Icon name="calendar" /></span>
  }
  if (type === 'aichat') {
    return <span className="desk-mark desk-mark-ai" aria-hidden><Icon name="sparkle" /></span>
  }
  if (type === 'wordbook') {
    return <span className="desk-mark desk-mark-wordbook" aria-hidden><Icon name="letters" /></span>
  }
  if (isDottedSource(type)) {
    return <span className="source-dot" aria-hidden />
  }
  return null
}
