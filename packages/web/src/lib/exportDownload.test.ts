// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareLibraryExport } from './exportDownload'
import { ExportWorkerStub } from '../test/exportWorker'

const doc = { exportedAt: '2026-09-20T00:00:00.000Z', collections: [] }
class ControlledWorker extends ExportWorkerStub {
  static instance: ControlledWorker
  constructor() { super(); ControlledWorker.instance = this }
  override postMessage() {}
}
beforeEach(() => vi.stubGlobal('Worker', ControlledWorker))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('terminates a conversion worker on cancellation', async () => {
  const controller = new AbortController()
  const result = prepareLibraryExport(doc, 'HTML', controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(ControlledWorker.instance.terminated).toBe(true)
})

it('surfaces worker failures and releases resources', async () => {
  const result = prepareLibraryExport(doc, 'Markdown', new AbortController().signal)
  const rejected = expect(result).rejects.toThrow('Could not prepare the export file.')
  ControlledWorker.instance.onerror!()
  await rejected
  expect(ControlledWorker.instance.terminated).toBe(true)
})

it('bounds the lifetime of an unresponsive worker', async () => {
  vi.useFakeTimers()
  const result = prepareLibraryExport(doc, 'JSON', new AbortController().signal)
  const rejected = expect(result).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  expect(ControlledWorker.instance.terminated).toBe(true)
})

it('receives a Blob and terminates the worker on success', async () => {
  vi.stubGlobal('Worker', ExportWorkerStub)
  const result = await prepareLibraryExport(doc, 'JSON', new AbortController().signal)
  expect(result.extension).toBe('json')
  expect(JSON.parse(await result.blob.text())).toEqual(doc)
})
