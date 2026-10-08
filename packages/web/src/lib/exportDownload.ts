import type { ExportLibraryDocument } from '../api'
import type { ExportFormat } from './exportLibrary'

type ExportFile = { blob: Blob; extension: string }

export function prepareLibraryExport(doc: ExportLibraryDocument, format: ExportFormat, signal: AbortSignal): Promise<ExportFile> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const worker = new Worker(new URL('./exportLibrary.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const abort = () => fail(signal.reason)
    const timeout = setTimeout(() => fail(new Error('Export conversion timed out.')), 60_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = () => fail(new Error('Could not prepare the export file.'))
    worker.onmessageerror = () => fail(new Error('Could not read the prepared export file.'))
    worker.onmessage = (event: MessageEvent<ExportFile | { error: string }>) => {
      cleanup()
      if ('error' in event.data) reject(new Error(event.data.error))
      else resolve(event.data)
    }
    try { worker.postMessage({ doc, format }) } catch (error) { fail(error) }
  })
}

export async function saveLibraryExport(doc: ExportLibraryDocument, jobId: string, format: ExportFormat, signal: AbortSignal) {
  const { blob, extension } = await prepareLibraryExport(doc, format, signal)
  signal.throwIfAborted()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `known-library-${jobId}.${extension}`
  document.body.append(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
