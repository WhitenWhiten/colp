// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushClientTelemetryForTests,
  installClientTelemetry,
  reportClientError,
  resetClientTelemetryForTests,
  routeTemplate,
} from './clientTelemetry'

/* R15-13: client errors reach the first-party sink with no user data. */

describe('client telemetry', () => {
  afterEach(() => {
    resetClientTelemetryForTests()
    window.history.replaceState(null, '', '/')
  })

  it('reduces paths to route templates without slugs, handles or ids', () => {
    expect(routeTemplate('/')).toBe('/')
    expect(routeTemplate('/c/private-medical-notes')).toBe('/c/:param')
    expect(routeTemplate('/u/alice')).toBe('/u/:param')
    expect(routeTemplate('/reports/weekly/issues/ed-2')).toBe('/reports/:param/issues/:param')
    expect(routeTemplate('/library/new')).toBe('/library/new')
    expect(routeTemplate('/library/col-1/edit')).toBe('/library/:param/edit')
    expect(routeTemplate('/explore')).toBe('/explore')
  })

  it('sends nothing until installed (dev, tests)', () => {
    const send = vi.fn()
    reportClientError('render_error', new Error('boom'))
    flushClientTelemetryForTests()
    expect(send).not.toHaveBeenCalled()
  })

  it('batches a render error with the route template and a scrubbed stack', () => {
    const send = vi.fn()
    installClientTelemetry({ force: true, send })
    window.history.replaceState(null, '', '/c/secret-slug?q=private')
    const error = new TypeError('x is undefined')
    error.stack = 'TypeError: x is undefined\n    at render (https://know-n.com/assets/Collection-abc.js:1:2)'
    reportClientError('render_error', error)
    expect(send).not.toHaveBeenCalled()
    flushClientTelemetryForTests()
    expect(send).toHaveBeenCalledTimes(1)
    const body = JSON.parse(send.mock.calls[0]![0] as string)
    expect(body.release).toMatch(/^[A-Za-z0-9._-]+$/u)
    expect(body.events).toEqual([{
      kind: 'error',
      source: 'render_error',
      route: '/c/:param',
      message: 'TypeError: x is undefined',
      stack: 'TypeError: x is undefined\n    at render (/assets/Collection-abc.js:1:2)',
    }])
    expect(send.mock.calls[0]![0]).not.toContain('secret-slug')
    expect(send.mock.calls[0]![0]).not.toContain('know-n.com')
  })

  it('caps errors per page so a crash loop cannot become a beacon loop', () => {
    const send = vi.fn()
    installClientTelemetry({ force: true, send })
    for (let i = 0; i < 100; i += 1) reportClientError('window_error', new Error(`e${i}`))
    flushClientTelemetryForTests()
    const events = send.mock.calls.flatMap((call) => JSON.parse(call[0] as string).events as unknown[])
    expect(events).toHaveLength(25)
    expect(send.mock.calls.every((call) => JSON.parse(call[0] as string).events.length <= 20)).toBe(true)
  })
})
