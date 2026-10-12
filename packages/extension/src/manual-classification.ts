/** Popup suggestions belong to this browser, independently of account preferences. */
export const MANUAL_CLASSIFICATION_AUTO = 'known.classification.manual-auto-suggest.v1';

export async function manualClassificationRequested(): Promise<boolean> {
  return (await chrome.storage.local.get(MANUAL_CLASSIFICATION_AUTO))[MANUAL_CLASSIFICATION_AUTO] === true;
}
