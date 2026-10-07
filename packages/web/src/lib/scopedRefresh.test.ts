import { afterEach, expect, it, vi } from 'vitest'
import { createScopedRefresh } from './scopedRefresh'
afterEach(() => vi.useRealTimers())
it('bounds continuous events by maxWait and rechecks dirty changes during an in-flight read', async () => {
  vi.useFakeTimers(); let release: (() => void) | undefined
  const read = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const queue = createScopedRefresh({ canRun: () => true, refresh: read })
  queue.invalidate('a')
  for (let i = 0; i < 9; i++) { await vi.advanceTimersByTimeAsync(100); queue.invalidate('a') }
  expect(read).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(100); expect(read).toHaveBeenCalledTimes(1)
  queue.invalidate('a'); await vi.advanceTimersByTimeAsync(200); expect(read).toHaveBeenCalledTimes(1)
  release!(); await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2)
  release!(); queue.dispose()
})
it('defers offline or edited views without discarding dirty data and respects Retry-After', async () => {
  vi.useFakeTimers(); let allowed = false
  const read = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue(undefined)
  const queue = createScopedRefresh({ canRun: () => allowed, refresh: read, retryAfter: () => 5000 })
  queue.invalidate('a'); await vi.advanceTimersByTimeAsync(2000); expect(read).not.toHaveBeenCalled()
  allowed = true; queue.wake(); await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(1)
  queue.invalidate('a'); await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(4000); expect(read).toHaveBeenCalledTimes(2); queue.dispose()
})
it('drops dirty work on identity reset even if the old request completes later', async () => {
  vi.useFakeTimers(); let release: (() => void) | undefined
  const read = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const queue = createScopedRefresh({ canRun: () => true, refresh: read })
  queue.invalidate('old'); await vi.advanceTimersByTimeAsync(150); queue.invalidate('old'); queue.reset()
  release!(); await vi.advanceTimersByTimeAsync(2000); expect(read).toHaveBeenCalledTimes(1); queue.dispose()
})
