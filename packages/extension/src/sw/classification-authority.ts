import { LOCAL_CLASSIFICATION_PROJECTION } from '../classification-local-session.js';
import { AUTHORITY_GENERATION_KEY } from '../authority-fence.js';
import { syncState } from './runtime.js';

export function installClassificationAuthorityListener() {
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local'&&[AUTHORITY_GENERATION_KEY,'known.sync.collection.v1'].some(key=>
      changes[key]&&JSON.stringify(changes[key].oldValue)!==JSON.stringify(changes[key].newValue))) {
      // The local provider key is account-independent; only the cached collection context goes stale.
      void chrome.storage.session.remove(LOCAL_CLASSIFICATION_PROJECTION).catch(()=>undefined);
    }
  });
}

/** Builds that confirmed popup AI tags on the server left confirmation records and a retry alarm behind. */
export async function retireClassificationConfirmations(): Promise<void> {
  await chrome.alarms.clear('known-classification-confirmation');
  await syncState.clearRetiredClassificationIntents();
}
