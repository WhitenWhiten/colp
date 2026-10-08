// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importWithRetry, isChunkLoadError, reloadOnce } from './lazyWithRetry'

const chunkError = () => new TypeError('Failed to fetch dynamically imported module: https://know-n.com/assets/Explore-abc.js')
const noSleep = () => Promise.resolve()

describe('lazyWithRetry', () => {
  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('recognises chunk-load errors from Chromium, Safari and Firefox', () => {
    expect(isChunkLoadError(chunkError())).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
  })

  it('retries a failed import twice before succeeding', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(chunkError())
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValueOnce('module')
    const sleep = vi.fn((_ms: number) => noSleep())
    await expect(importWithRetry('Explore', load, { sleep })).resolves.toBe('module')
    expect(load).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([300, 1_000])
  })

  it('reloads once after the retries fail, then lets the error through', async () => {
    const reload = vi.fn()
    const load = vi.fn().mockRejectedValue(chunkError())

    const pending = importWithRetry('Explore', load, { sleep: noSleep, reload })
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(load).toHaveBeenCalledTimes(3)
    void pending

    // Same tab after the reload: the flag is set, so the error surfaces.
    await expect(importWithRetry('Explore', load, { sleep: noSleep, reload })).rejects.toThrow(/dynamically imported/)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears the reload guard once the chunk loads', async () => {
    const reload = vi.fn()
    expect(reloadOnce('Explore', reload)).toBe(true)
    await importWithRetry('Explore', () => Promise.resolve('module'), { sleep: noSleep, reload })
    expect(reloadOnce('Explore', reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('never reloads when session storage is unavailable', () => {
    const reload = vi.fn()
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(reloadOnce('Explore', reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
