import { useState } from 'react'
import { FilterRail } from '../../components/FilterRail'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/AppToast'
import { copyTextToClipboard } from '../../lib/clipboard'
import { canonicalSiteOrigin } from '../../lib/chrome'
import { escapeHtmlAttr } from './helpers'
import { EmbedAppearanceControls } from './EmbedAppearanceControls'
import { embedAgentPrompt } from './embedAgentPrompt'
import { appearanceQuery, embedFrameCss, embedFrameStyle, embedIframeCss, embedIframeStyle, suggestEmbedHeight, type EmbedAppearance } from './embedAppearance'

type EmbedTheme = 'light' | 'dark' | 'auto'
type EmbedSize = 'default' | 'compact'

/** Shared snippet generator for collection and digest public pages. The
    collection share page renders it inline under its own "Embed" eyebrow;
    the digest dialog already titles it, so it passes `heading={false}`. */
export function EmbedComposer({ path, title, rowCount = 5, detailHeight = 0, heading = true }: { path: string; title: string; rowCount?: number; detailHeight?: number; heading?: boolean }) {
  const { toast } = useToast()
  const origin = canonicalSiteOrigin()
  const url = `${origin}${path}`
  /* The snippet runs on unknown third-party pages: lazy so it never blocks
     the host page, sandboxed to the minimum the card needs (its own scripts,
     same-origin API, popups so target=_blank rows escape), a conservative
     referrer policy, and a neutral gray border on a wrapper element — a border
     painted on the iframe box itself can lose to the embedded document's
     composited layer at fractional device pixels. */
  const [embedTheme, setEmbedTheme] = useState<EmbedTheme>('light')
  const [embedSize, setEmbedSize] = useState<EmbedSize>('default')
  const [embedAppearance, setEmbedAppearance] = useState<EmbedAppearance>({})
  const embedQuery = [
    'embed=1',
    embedTheme === 'light' ? '' : `theme=${embedTheme}`,
    embedSize === 'compact' ? 'compact' : '',
    appearanceQuery(embedAppearance).toString(),
  ].filter(Boolean).join('&')
  const embedSrc = `${url}?${embedQuery}`
  const embedHeight = suggestEmbedHeight({ compact: embedSize === 'compact', rowCount, detailHeight, appearance: embedAppearance })
  const embedCode = `<div style="${escapeHtmlAttr(embedFrameCss(embedAppearance))}"><iframe src="${escapeHtmlAttr(embedSrc)}" width="100%" height="${embedHeight}" style="${embedIframeCss}" title="${escapeHtmlAttr(title)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`

  const copy = async (text: string, done: string) => {
    try {
      await copyTextToClipboard(text)
      toast(done)
    } catch {
      toast('Copy failed — select the text manually')
    }
  }

  return (
    <div className="share-embed-block" data-testid="share-embed-block">
      {heading ? <p className="eyebrow">Embed</p> : null}
      <div className="share-embed-live" style={embedFrameStyle(embedAppearance)}>
        <iframe
          style={embedIframeStyle}
          data-testid="share-embed-live"
          /* Relative so the preview hits this origin in dev and prod
             alike; the snippet below keeps the absolute URL. */
          src={`${path}?${embedQuery}`}
          height={embedHeight}
          title={`Embed preview: ${title}`}
          loading="lazy"
          /* Mirror the snippet's sandbox: without allow-popups the
             card's target=_blank rows are silently swallowed here,
             and the preview would lie about the embedded behavior. */
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
      <div className="share-embed-options">
        <FilterRail<EmbedTheme>
          className="view-switch"
          variant="segments"
          label="Embed theme"
          value={embedTheme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'auto', label: 'Auto', title: "Follows the visitor's system theme" },
          ]}
          onChange={setEmbedTheme}
        />
        <FilterRail<EmbedSize>
          className="view-switch"
          variant="segments"
          label="Embed size"
          value={embedSize}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'compact', label: 'Compact', title: 'Title and links only' },
          ]}
          onChange={setEmbedSize}
        />
      </div>
      <EmbedAppearanceControls value={embedAppearance} onChange={setEmbedAppearance} />
      <div className="share-embed-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void copy(embedCode, 'Embed code copied')}>
          Copy embed code
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void copy(
            embedAgentPrompt({ guideUrl: `${origin}/embed-guide.md`, embedUrl: embedSrc }),
            'Prompt copied — paste it into your coding agent',
          )}
        >
          Copy agent prompt
        </button>
      </div>
      <p className="meta share-embed-hint">
        Paste the prompt into your coding agent (Claude Code, Cursor…) and it will fit the card to your site using the <a href="/embed-guide">embed guide</a>.
      </p>
      <details className="share-embed-code-toggle">
        <summary>View code <Icon name="chevron-down" /></summary>
        <pre className="share-embed-code" data-testid="share-embed-code">{embedCode}</pre>
      </details>
    </div>
  )
}
