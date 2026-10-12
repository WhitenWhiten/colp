import type {AuthorityContext} from '../authority-fence.js';
import type {SyncScope} from '../sync-state-store.js';
import type {CompleteRemoteSnapshot} from '../bootstrap/remote-snapshot.js';
import {localClassificationCredential,LOCAL_CLASSIFICATION_PROJECTION} from '../classification-local-session.js';
import {classificationProjectionFromSnapshot,localProjectionIsQuiet,readLocalClassificationProjection} from '../classification-local-projection.js';
import {syncState,store} from './runtime.js';
import {importBrowserMetadata} from './bookmark-metadata.js';
/** Optional enrichment for local mode (descriptions, tag vocabulary), cached after a successful sync cycle; no second sync queue or native mutation. */
export async function refreshLocalClassificationProjection(scope:SyncScope,context:AuthorityContext,read:(classificationProjection:boolean)=>Promise<CompleteRemoteSnapshot>,needsDescriptionSnapshot=false){
  const credential=await localClassificationCredential();
  if((!credential&&!needsDescriptionSnapshot)||!await localProjectionIsQuiet(syncState,scope))return;
  if(credential&&!needsDescriptionSnapshot){
    try{await readLocalClassificationProjection(syncState,scope,context.generation);return;}catch{/* Refresh when the scope or acknowledged cursor changed. */}
  }
  try{
    const startedAt=Date.now();
    // Metadata migration uses ordinary snapshot bounds. AI context limits must not block description sync.
    const before=await syncState.getEngineState(scope),snapshot=await read(!needsDescriptionSnapshot);
    await store.fence.assertWritable(context.generation);
    const after=await syncState.getEngineState(scope);
    if(!before?.lastAckedCursor||after?.lastAckedCursor!==before.lastAckedCursor||!await localProjectionIsQuiet(syncState,scope))return;
    await importBrowserMetadata(scope,context,snapshot);
    if(credential&&snapshot.classificationProjection){
      const projection=classificationProjectionFromSnapshot(snapshot,scope,context.generation,before.lastAckedCursor,startedAt);
      await chrome.storage.session.set({[LOCAL_CLASSIFICATION_PROJECTION]:projection});
    }
  }catch{/* Collection context is optional; durable native descriptions remain usable. */}
}
