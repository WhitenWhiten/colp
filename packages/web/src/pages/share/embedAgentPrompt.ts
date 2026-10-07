/* The one-click "Copy agent prompt" text. The prompt stays short on purpose:
   the embed guide (content/agent-public/embed-guide.md) carries the full
   instructions, so styling rules, parameters and new card styles are
   documented there and every copied prompt picks them up without a UI
   change. This file only decides what the user hands their agent. */

/**
 * Card styles the embed offers. Only the list card exists today; a new style
 * (e.g. a big-item card) adds an entry here and its section in the guide.
 */
export const embedCardStyles = {
  list: { label: 'list card' },
} as const

export type EmbedCardStyle = keyof typeof embedCardStyles

/** Left in the prompt for the user to fill before sending. */
export const EMBED_PROMPT_SITE_PLACEHOLDER = '[your website URL or project folder]'

export function embedAgentPrompt({
  guideUrl,
  embedUrl,
  cardStyle = 'list',
}: {
  /** Absolute URL of the Markdown embed guide. */
  guideUrl: string
  /** Absolute card URL, carrying the style already chosen in the editor. */
  embedUrl: string
  cardStyle?: EmbedCardStyle
}): string {
  return [
    `Read ${guideUrl} and follow it.`,
    `Embed this Know-N ${embedCardStyles[cardStyle].label} on my website: ${embedUrl}`,
    `Match it to my site's design: ${EMBED_PROMPT_SITE_PLACEHOLDER}`,
  ].join('\n')
}
