import { parseStoredImportConversion, type ImportConversionResult } from './import-preview.js';

export const IMPORT_PREVIEW_CACHE = 'known.import.preview.v1';

interface SessionStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/**
 * Durable home for the one in-flight import preview. The MV3 worker dies
 * between "preview" and "commit" whenever the user takes their time on the
 * options page; the RAM map alone then forces a preview_expired retry.
 * chrome.storage.session survives worker restarts and is cleared when the
 * browser exits — exactly the lifetime a preview should have.
 */
export async function writeImportPreviewCache(area: SessionStorageArea,
  conversion: ImportConversionResult): Promise<void> {
  await area.set({ [IMPORT_PREVIEW_CACHE]: { conversion, storedAt: Date.now() } });
}

export async function readImportPreviewCache(area: SessionStorageArea,
  digest: string): Promise<ImportConversionResult | undefined> {
  const value = (await area.get(IMPORT_PREVIEW_CACHE))[IMPORT_PREVIEW_CACHE];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const conversion = parseStoredImportConversion((value as Record<string, unknown>).conversion);
  return conversion && conversion.digest === digest ? conversion : undefined;
}

export async function clearImportPreviewCache(area: SessionStorageArea): Promise<void> {
  await area.remove(IMPORT_PREVIEW_CACHE);
}
