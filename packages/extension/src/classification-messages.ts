import type { ClassificationPreviewRequest } from './classification-product-client.js';
type PreviewTrigger = { readonly userGesture: true } | { readonly automatic: true };
export type ClassificationRequest = {readonly kind:'known.classification.session'}
  | {readonly kind:'known.classification.settings';readonly collectionId:string}
  | {readonly kind:'known.classification.folder';readonly collectionId:string;readonly folderId:string;readonly userGesture:true}
  | ({readonly kind:'known.classification.preview';readonly collectionId:string;readonly commandId:string;readonly document:ClassificationPreviewRequest} & PreviewTrigger)
  /** Local-first: the user's own provider over this browser's folders; no collection, account or billing. */
  | ({readonly kind:'known.classification.local-preview';readonly commandId:string;readonly document:ClassificationPreviewRequest} & PreviewTrigger);
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const id=(value:unknown)=>typeof value==='string'&&value.trim().length>0&&new TextEncoder().encode(value).length<=128;
export function validClassificationRequest(value:unknown):value is ClassificationRequest {
  if(!record(value))return false;
  const keys=Object.keys(value);
  if(value.kind==='known.classification.session')return keys.length===1;
  if(value.kind==='known.classification.local-preview'){
    const body=value.document;
    return keys.length===4&&record(body)&&!Object.hasOwn(body,'billing')&&!Object.hasOwn(body,'nodeId')
      &&validClassificationRequest({...value,kind:'known.classification.preview',collectionId:'local'});
  }
  if(!id(value.collectionId))return false;
  if(value.kind==='known.classification.settings')return keys.length===2;
  if(value.kind==='known.classification.folder')return keys.length===4&&value.userGesture===true&&id(value.folderId);
  const trigger=value.userGesture===true&&!Object.hasOwn(value,'automatic')||value.automatic===true&&!Object.hasOwn(value,'userGesture');
  if(value.kind!=='known.classification.preview'||keys.length!==5||!trigger||typeof value.commandId!=='string'
    ||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.commandId))return false;
  const body=value.document;
  if(!record(body)||Object.keys(body).length<3||Object.keys(body).length>6||body.source!=='extension'||!record(body.requested))return false;
  if(Object.keys(body).some(key=>!['source','requested','nodeId','bookmark','billing','rejectedFolderIds','folderSelectionMode'].includes(key)))return false;
  // "Suggest another": the folders already turned down for this page.
  if(Object.hasOwn(body,'rejectedFolderIds')&&(!Array.isArray(body.rejectedFolderIds)||!body.rejectedFolderIds.length||body.rejectedFolderIds.length>8
    ||!body.rejectedFolderIds.every(id)||new Set(body.rejectedFolderIds).size!==body.rejectedFolderIds.length))return false;
  if(Object.hasOwn(body,'folderSelectionMode')&&(typeof body.folderSelectionMode!=='string'||!['allow_later','require_candidate'].includes(body.folderSelectionMode)
    ||body.requested.folder!==true||value.automatic===true&&body.folderSelectionMode==='require_candidate'))return false;
  if(Object.hasOwn(body,'billing')){
    if(!record(body.billing)||Object.keys(body.billing).length!==2||typeof body.billing.priceVersion!=='string'
      ||!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(body.billing.priceVersion)||typeof body.billing.maxPoints!=='number'
      ||!Number.isInteger(body.billing.maxPoints)||body.billing.maxPoints<0||body.billing.maxPoints>2_147_483_647)return false;
  }
  if(Object.keys(body.requested).length!==2||typeof body.requested.folder!=='boolean'||typeof body.requested.tags!=='boolean'||(!body.requested.folder&&!body.requested.tags))return false;
  if(Object.hasOwn(body,'nodeId'))return value.automatic!==true&&id(body.nodeId);
  if(!record(body.bookmark)||Object.keys(body.bookmark).length!==3||typeof body.bookmark.title!=='string'||typeof body.bookmark.url!=='string'
    ||(body.bookmark.description!==null&&typeof body.bookmark.description!=='string'))return false;
  const bytes=(value:string)=>new TextEncoder().encode(value).length;
  if(!body.bookmark.title.trim()||body.bookmark.title.length>512||bytes(body.bookmark.title)>1024||bytes(body.bookmark.url)>4096
    ||(typeof body.bookmark.description==='string'&&bytes(body.bookmark.description)>16384))return false;
  try{const url=new URL(body.bookmark.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/\s/u.test(body.bookmark.url))return false;}catch{return false;}
  return bytes(JSON.stringify(body))<=128*1024;
}
