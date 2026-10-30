export const LOCAL_CLASSIFICATION_CONTEXT = 'known.classification.local-context.v1';
export type ClassificationContextWarning = 'folder_descriptions_unavailable' | 'tag_vocabulary_unavailable';
export interface ClassificationContextStatus { at: number; warnings: ClassificationContextWarning[] }

/** Optional context failures are diagnostic facts; they never gate a folder suggestion. */
export async function recordClassificationContext(warnings: ClassificationContextWarning[]): Promise<void> {
  try { await chrome.storage.session.set({ [LOCAL_CLASSIFICATION_CONTEXT]: { at: Date.now(), warnings } }); }
  catch { /* Diagnostic storage is optional too. */ }
}
export async function readClassificationContext(): Promise<ClassificationContextStatus | null> {
  try {
    const raw = (await chrome.storage.session.get(LOCAL_CLASSIFICATION_CONTEXT))[LOCAL_CLASSIFICATION_CONTEXT] as ClassificationContextStatus | undefined;
    return raw && Number.isFinite(raw.at) && Array.isArray(raw.warnings)
      ? { at: raw.at, warnings: raw.warnings.filter(w => ['folder_descriptions_unavailable', 'tag_vocabulary_unavailable'].includes(w)) } : null;
  } catch { return null; }
}
