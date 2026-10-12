import type { MappingInput } from './sync-state-store.js';
import { t } from './i18n.js';
import { isUnsupportedBookmarkFolder } from './bookmark-folder-policy.js';
import type { FolderTreeNode } from './save-folder.js';
export interface ClassificationNativeFolder {readonly folderId:string;readonly nativeId:string;readonly title:string}
/** Only authoritative scoped mappings can translate a server directory into a browser destination. */
export async function resolveClassificationNativeFolder(folderId:string|null,deps:{
  readonly mapping:(id:string)=>Promise<MappingInput|undefined|null>;
  readonly native:(id:string)=>Promise<Pick<FolderTreeNode,'title'|'url'|'unmodifiable'|'parentId'|'folderType'>|undefined>;
  readonly inScope:(nativeId:string)=>Promise<boolean>;
}):Promise<ClassificationNativeFolder|null>{
  if(!folderId)return null;
  const mapping=await deps.mapping(folderId);
  if(!mapping||mapping.colpId!==folderId||mapping.nodeKind!=='folder'||/^(?:recovery|sidecar|unmounted):/u.test(mapping.nativeId))return null;
  const node=await deps.native(mapping.nativeId);
  if(!node||node.url!==undefined||node.unmodifiable||await isUnsupportedBookmarkFolder(mapping.nativeId,deps.native)||!await deps.inScope(mapping.nativeId))return null;
  return {folderId,nativeId:mapping.nativeId,title:node.title||t('common_untitledFolder', 'Untitled folder')};
}
