import { exclusionIds, isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import type {AuthorityContext} from '../authority-fence.js';
import type {ClassificationRequest} from '../classification-messages.js';
import type {ClassificationPreviewRequest} from '../classification-product-client.js';
import type {ClassificationNativeFolder} from '../classification-folder.js';
import type {FolderTreeNode} from '../save-folder.js';
import type {ClassificationTagUsage} from '../generated/classification/classification-policy.js';
import {localClassificationFailure} from '../classification-local-failure.js';
import {localClassificationCredential} from '../classification-local-session.js';
import {readLocalClassificationProjection} from '../classification-local-projection.js';
import {previewLocalClassification} from '../classification-local-preview.js';
import {nativeClassificationFolders} from '../classification-local-taxonomy.js';
import {readNativeFolderDescriptions} from '../folder-description-native.js';
import {currentSyncScope} from './scope.js';
import {syncState} from './runtime.js';
import {localClassificationTags} from '../classification-local-tags.js';
import {isUnsupportedBookmarkFolder} from '../bookmark-folder-policy.js';

type LocalPreviewRequest=Extract<ClassificationRequest,{kind:'known.classification.local-preview'}>;

/**
 * Optional context from a synced collection: folder descriptions (translated to
 * native ids) and the tag vocabulary. Absent when signed out, unsynced or stale;
 * local suggestions then use folder titles and bounded existing-bookmark examples.
 */
async function syncedContext(generation:number){
  try{
    const scope=await currentSyncScope();
    const projection=await readLocalClassificationProjection(syncState,scope,generation);
    const descriptions=new Map<string,string>();
    for(const folder of projection.folders){
      if(!folder.description)continue;
      const mapping=await syncState.getMappingByColpId(scope,folder.id);
      if(mapping?.nodeKind==='folder'&&/^\d+$/u.test(mapping.nativeId))descriptions.set(mapping.nativeId,folder.description);
    }
    return {descriptions,tagUsage:projection.tagUsage,title:projection.title,summary:projection.summary,
      revision:projection.contentRevision,collectionId:projection.collectionId};
  }catch{return null;}
}

async function suggestedFolder(id:string|null|undefined):Promise<ClassificationNativeFolder|null>{
  if(!id)return null;
  const node=(await chrome.bookmarks.get(id).catch(()=>[]))[0];
  if(!node||node.url!==undefined||node.unmodifiable||await isUnsupportedBookmarkFolder(id)||await isSubscriptionExcluded(id).catch(()=>true))return null;
  return {folderId:id,nativeId:id,title:node.title};
}

let busy=false;
/** Local-first preview for the popup: needs only the session key and this browser's folders — no account or collection. */
export function localClassificationPreview(message:LocalPreviewRequest,context:AuthorityContext){
  return runLocalClassification({document:message.document,commandId:message.commandId,generation:context.generation,signal:context.signal});
}

/** Shared by the popup and automatic save: one provider call over native folders, spent once per command id. */
export async function runLocalClassification(input:{readonly document:ClassificationPreviewRequest;readonly commandId:string;
  readonly generation:number;readonly signal:AbortSignal;readonly excludeBookmarkId?:string}){
  const credential=await localClassificationCredential();
  if(!credential)return {ok:false as const,error:'local_key_required'};
  if(busy)return {ok:false as const,error:'local_call_in_progress'};
  busy=true;
  try{
    const synced=await syncedContext(input.generation);
    const tree=await chrome.bookmarks.getTree() as FolderTreeNode[];
    const descriptions=new Map<string,string|null>(synced?.descriptions??[]);
    for(const [id,description] of await readNativeFolderDescriptions(tree))descriptions.set(id,description);
    const folders=nativeClassificationFolders(tree,{excluded:await exclusionIds(),excludeBookmarkId:input.excludeBookmarkId,descriptions});
    const document=input.document;
    // A rule's placement asks for tags only (`folder:false`); nothing is sent when there are no tags to choose from.
    const folder=!('folder' in document.requested)||document.requested.folder!==false;
    if(folder&&!folders.length)return {ok:false as const,error:'local_no_folders'};
    const tagUsage:readonly ClassificationTagUsage[]=await localClassificationTags(synced?.tagUsage);
    const requested={folder,tags:document.requested.tags===true&&tagUsage.length>0} as typeof document.requested;
    if(!requested.folder&&!requested.tags)return {ok:false as const,error:'local_no_tags'};
    const result=await previewLocalClassification({credential,
      taxonomy:{folders,tagUsage,title:synced?.title??'Browser bookmarks',summary:synced?.summary??null,
        revision:synced?.revision??'native',collectionId:synced?.collectionId??'local'},
      document:{...document,requested},commandId:input.commandId,signal:input.signal,
      async assertCurrent(){
        if((await localClassificationCredential())?.generation!==credential.generation)throw new Error('local_authority_changed');
      }});
    return {ok:true as const,result,nativeFolder:await suggestedFolder(result.folder?.folderId),tagsNeedSync:false};
  }catch(error){
    return {ok:false as const,error:localClassificationFailure(error)};
  }finally{busy=false;}
}
