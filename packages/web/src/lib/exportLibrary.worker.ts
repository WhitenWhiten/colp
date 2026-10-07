import type { ExportLibraryDocument } from '../api'
import { serializeLibraryExport, type ExportFormat } from './exportLibrary'

self.onmessage = (event: MessageEvent<{ doc: ExportLibraryDocument; format: ExportFormat }>) => {
  try {
    const { content, type, extension } = serializeLibraryExport(event.data.doc, event.data.format)
    // Blob avoids copying the full serialized string back to the UI thread.
    self.postMessage({ blob: new Blob([content], { type }), extension })
  } catch {
    self.postMessage({ error: 'Could not prepare the export file.' })
  }
}
