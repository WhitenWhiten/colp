import type {ClassificationFolderInput} from './generated/classification/classification-policy.js';
import {addClassificationFolderExamples} from './generated/classification/classification-folder-examples.js';
import type {FolderTreeNode} from './save-folder.js';
import {isSupportedBookmarkRoot} from './bookmark-folder-policy.js';

/** Same ceiling as the synced projection: past this the provider prompt is not worth building. */
export const LOCAL_TAXONOMY_MAX_FOLDERS=10000;

/**
 * Local-first candidates: the browser's own folders, the same set the popup
 * picker offers. The built-in roots (Bookmarks bar, Other bookmarks, …) are
 * containers rather than topics, so their child folders become the top level.
 * Workspace, managed (`unmodifiable`) and read-only subscription subtrees are skipped,
 * since a save there is refused anyway. Folder descriptions are durable local
 * metadata, keyed by native id, with synced context as an optional enrichment.
 */
export function nativeClassificationFolders(roots:readonly FolderTreeNode[],input:{
  readonly excluded:ReadonlySet<string>;readonly descriptions?:ReadonlyMap<string,string|null>;
  readonly excludeBookmarkId?:string;
}):ClassificationFolderInput[]{
  const folders:ClassificationFolderInput[]=[];
  const bookmarks:{parentId:string;title:string;url:string}[]=[];
  const visit=(node:FolderTreeNode,parentId:string|null)=>{
    if(node.unmodifiable||input.excluded.has(node.id))return;
    if(node.url!==undefined){
      if(parentId!==null&&node.id!==input.excludeBookmarkId)bookmarks.push({parentId,title:node.title,url:node.url});
      return;
    }
    if(folders.length>=LOCAL_TAXONOMY_MAX_FOLDERS)throw new Error('local_taxonomy_too_large');
    folders.push({id:node.id,parentId,title:node.title,description:input.descriptions?.get(node.id)??null});
    for(const child of node.children??[])visit(child,node.id);
  };
  for(const root of roots)for(const container of root.children??[]){
    if(container.url!==undefined||container.unmodifiable||input.excluded.has(container.id)||!isSupportedBookmarkRoot(container))continue;
    for(const child of container.children??[])visit(child,null);
  }
  return [...addClassificationFolderExamples({folders,bookmarks})];
}
