import { describe, expect, it } from 'vitest'
import { EMBED_PROMPT_SITE_PLACEHOLDER, embedAgentPrompt, embedCardStyles } from './embedAgentPrompt'

describe('embed agent prompt', () => {
  it('points the agent at the guide, names the card and leaves the site for the user', () => {
    const prompt = embedAgentPrompt({
      guideUrl: 'https://know-n.com/embed-guide.md',
      embedUrl: 'https://know-n.com/reports/weekly?embed=1&theme=dark',
    })
    const lines = prompt.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Read https://know-n.com/embed-guide.md and follow it.')
    expect(lines[1]).toContain(embedCardStyles.list.label)
    expect(lines[1]).toContain('https://know-n.com/reports/weekly?embed=1&theme=dark')
    expect(lines[2]).toContain(EMBED_PROMPT_SITE_PLACEHOLDER)
  })
})
