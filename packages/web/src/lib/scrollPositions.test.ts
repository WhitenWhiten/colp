// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'known.scroll.v1'

/* The module keeps a session-level in-memory cache, so every test reloads it
   via resetModules + dynamic import to start from a clean slate. */
async function loadModule() {
  return import('./scrollPositions')
}

describe('scrollPositions', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.resetModules()
  })

  it('evicts the oldest entry once the map grows past 50', async () => {
    const { savePosition, readPosition } = await loadModule()
    for (let index = 0; index < 51; index += 1) {
      savePosition(`key-${index}`, index)
    }
    // 51 distinct keys push the first one out of the LRU window.
    expect(readPosition('key-0')).toBeUndefined()
    expect(readPosition('key-1')).toBe(1)
    expect(readPosition('key-50')).toBe(50)
  })

  it('rewriting an existing key refreshes its freshness', async () => {
    const { savePosition, readPosition } = await loadModule()
    for (let index = 0; index < 50; index += 1) {
      savePosition(`key-${index}`, index)
    }
    // Re-saving key-0 makes it the newest entry…
    savePosition('key-0', 1000)
    // …so the 51st distinct key evicts key-1, not the refreshed key-0.
    savePosition('key-50', 50)
    expect(readPosition('key-0')).toBe(1000)
    expect(readPosition('key-1')).toBeUndefined()
  })

  it('mirrors every save into sessionStorage in LRU order', async () => {
    const { savePosition } = await loadModule()
    savePosition('entry-a', 320)
    savePosition('entry-b', 640)
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual([
      ['entry-a', 320],
      ['entry-b', 640],
    ])
  })

  it('rehydrates from sessionStorage after a full reload', async () => {
    const before = await loadModule()
    before.savePosition('entry-a', 320)

    // A reload drops the module-level cache but keeps sessionStorage —
    // the history entry key survives in history.state, so the position
    // must still be readable.
    vi.resetModules()
    const after = await loadModule()
    expect(after.readPosition('entry-a')).toBe(320)
  })

  it('ignores a foreign payload already sitting in storage', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '{"not":"an array of pairs"}')
    const { readPosition, savePosition } = await loadModule()
    expect(readPosition('entry-a')).toBeUndefined()
    // …and the module recovers instead of staying broken.
    savePosition('entry-a', 10)
    expect(readPosition('entry-a')).toBe(10)
  })
})
