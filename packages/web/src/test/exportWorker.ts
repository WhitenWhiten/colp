import type { ExportLibraryDocument } from '../api'
import { serializeLibraryExport, type ExportFormat } from '../lib/exportLibrary'

/** In-process worker stand-in for DOM tests; browser E2E exercises the real worker. */
export class ExportWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  postMessage({ doc, format }: { doc: ExportLibraryDocument; format: ExportFormat }) {
    void Promise.resolve().then(() => {
      if (this.terminated) return
      const { content, type, extension } = serializeLibraryExport(doc, format)
      this.onmessage?.(new MessageEvent('message', { data: { blob: new Blob([content], { type }), extension } }))
    })
  }
  terminate() { this.terminated = true }
}
