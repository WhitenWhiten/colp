import { describe, expect, it } from 'vitest'
import { ProgressBar } from './ProgressBar'
import { renderToStaticMarkup } from 'react-dom/server'

describe('ProgressBar', () => {
  it('exposes a semantic tone class for health-style tracks', () => {
    const html = renderToStaticMarkup(<ProgressBar value={32} tone="danger" label="Unhealthy" />)
    expect(html).toContain('p0-progress--danger')
    expect(html).toContain('role="progressbar"')
  })
})
