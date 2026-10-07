import { describe, expect, it } from 'vitest'
import { appearanceChoices, appearanceColors, appearanceNumbers, appearanceQuery, embedAppearanceStyle, embedAttributionOnDark, embedFrameCss, embedHeightAllowance, parseEmbedAppearance } from './embedAppearance'

describe('public embed appearance boundary', () => {
  it('rejects CSS payloads, remote resources, unknown fields and out-of-range numbers', () => {
    const params = new URLSearchParams({ bg: 'url(https://evil.test)', text: '#fff;display:none', font: 'https://evil.test/font', padding: '999', fontSize: '12px', radius: '-1', decoration: 'url(x)', hideBrand: 'true' })
    expect(parseEmbedAppearance(params)).toEqual({})
    expect(embedAppearanceStyle(Object.fromEntries(params))).toEqual({})
    expect(appearanceQuery(Object.fromEntries(params)).toString()).toBe('')
  })

  it('round trips supported settings and preserves readable attribution independently of text', () => {
    const appearance = { bg: '#FFFFFF', text: '#ffffff', font: 'sans', metaFont: 'mono', density: 'comfortable', divider: 'dotted', decoration: 'checker', radius: '0', padding: '28', fontSize: '18' }
    const parsed = parseEmbedAppearance(appearanceQuery(appearance))
    expect(parsed).toEqual({ ...appearance, bg: '#ffffff' })
    expect(embedAppearanceStyle(parsed)).toMatchObject({ '--embed-brand-ink': '#000000', '--ink': '#ffffff', '--embed-padding': '28px', '--embed-divider': 'dotted' })
    expect(embedAppearanceStyle({ bg: '#000000', text: '#000000' })).toMatchObject({ '--embed-brand-ink': '#ffffff' })
    // A chosen font carries the title too; by default it keeps the serif.
    const style = embedAppearanceStyle(parsed) as Record<string, string>
    expect(style['--embed-title-font']).toBe(style['--embed-font'])
    expect(embedAppearanceStyle({})).not.toHaveProperty('--embed-title-font')
    expect(embedFrameCss(parsed)).toContain('border-radius:0px')
    expect(embedHeightAllowance(parsed, 5)).toBeGreaterThan(80)
  })

  it('picks the attribution wordmark variant from a custom ground first, then the theme', () => {
    expect(embedAttributionOnDark({}, false)).toBe(false)
    expect(embedAttributionOnDark({}, true)).toBe(true)
    expect(embedAttributionOnDark({ bg: '#202a36' }, false)).toBe(true)
    expect(embedAttributionOnDark({ bg: '#fafafa' }, true)).toBe(false)
    // An invalid bg is not a ground: the theme decides.
    expect(embedAttributionOnDark({ bg: 'url(x)' }, true)).toBe(true)
    // Same threshold as --embed-brand-ink, so the mark and the footer ink agree.
    for (const bg of ['#767676', '#777777', '#000000', '#ffffff']) {
      const ink = (embedAppearanceStyle({ bg }) as Record<string, string>)['--embed-brand-ink']
      expect(embedAttributionOnDark({ bg }, false)).toBe(ink === '#ffffff')
    }
  })

  it('leaves legacy embed defaults intact', () => {
    expect(appearanceQuery({}).toString()).toBe('')
    expect(embedAppearanceStyle({})).toEqual({})
    expect(embedHeightAllowance({}, 4)).toBe(0)
    expect(embedFrameCss({})).toBe('border:1px solid rgba(128 128 128 / 0.35);border-radius:8px;overflow:hidden')
  })
})

describe('appearance hostile inputs and contract edges', () => {
  const attacks = ['url(https://attacker.invalid/x)', '@import "https://attacker.invalid"', '</style><script>alert(1)</script>', '" onload="alert(1)', 'var(--ink)', '#123456;display:none', '#123456\n', '#123456\r', '#12345600', 'transparent', 'inherit', 'constructor', '__proto__', 'x'.repeat(8192)]
  it.each(attacks)('rejects %s across every appearance field and output sink', value => {
    const fields = [...Object.keys(appearanceChoices), ...appearanceColors, ...Object.keys(appearanceNumbers)]
    const raw = Object.fromEntries(fields.map(key => [key, value]))
    expect(parseEmbedAppearance(new URLSearchParams(raw))).toEqual({})
    expect(appearanceQuery(raw).toString()).toBe('')
    expect(embedAppearanceStyle(raw)).toEqual({})
    expect(embedFrameCss(raw)).toBe(embedFrameCss({}))
    expect(embedHeightAllowance(raw, 5)).toBe(0)
  })

  it.each(Object.entries(appearanceNumbers))('enforces both bounds and integer syntax for %s', (key, range) => {
    for (const number of [range.min, range.max]) {
      expect(parseEmbedAppearance(new URLSearchParams({ [key]: String(number) }))).toEqual({ [key]: String(number) })
    }
    for (const value of [String(range.min - 1), String(range.max + 1), '8\n', '8\r', ' 8', '8 ', '8.0', '8e0', '+8', 'NaN', 'Infinity', '１２']) {
      expect(parseEmbedAppearance(new URLSearchParams({ [key]: value }))).toEqual({})
    }
  })

  it.each(Object.entries(appearanceChoices))('accepts every documented %s choice', (key, choices) => {
    for (const value of choices) expect(parseEmbedAppearance(new URLSearchParams({ [key]: value }))).toEqual({ [key]: value })
  })

  it('decodes once, uses the first duplicate and never copies unknown properties', () => {
    expect(parseEmbedAppearance(new URLSearchParams('bg=%2523ffffff&font=%2573ans'))).toEqual({})
    expect(parseEmbedAppearance(new URLSearchParams('bg=%23ABCDEF&bg=url(x)&font=mono&font=serif'))).toEqual({ bg: '#abcdef', font: 'mono' })
    expect(parseEmbedAppearance(new URLSearchParams('bg=url(x)&bg=%23abcdef&__proto__=x&hideBrand=true&href=https://attacker.invalid'))).toEqual({})
  })

  it('chooses a footer color with at least 4.5:1 contrast throughout a sampled RGB cube', () => {
    for (const red of [0, 51, 102, 153, 204, 255]) for (const green of [0, 51, 102, 153, 204, 255]) for (const blue of [0, 51, 102, 153, 204, 255]) {
      const channels = [red, green, blue]
      const bg = '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('')
      const result = embedAppearanceStyle({ bg, text: bg, muted: bg, accent: bg }) as Record<string, string>
      const luminance = channels.reduce((sum, channel, index) => {
        const c = channel / 255
        return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
      }, 0)
      const contrast = result['--embed-brand-ink'] === '#000000' ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
    }
  })
})
