export interface CollectionReadActor { accountId:string;subjectId:string }
export interface ActorCollectionFacts {
  id:string;title:string;summary:string|null;ownerSubjectId:string;visibility:'private'|'protected'|'public'|'unlisted';
  rootNodeId:string;contentRevision:string;updatedAt:string;
}
export interface ActorCollectionMetadata {
  c:ActorCollectionFacts;member:boolean;followed:boolean;shared:boolean;role:'editor'|'viewer';openUrl:string;policyRevision:string;
}
export interface ActorCollectionNode {
  id:string;parentId:string|null;kind:'folder'|'bookmark'|'separator';title:string|null;url:string|null;description:string|null;
  resourceRevision:string;visibility:'inherit'|'protected'|'private';
}
export interface ActorCollectionAnnotation { id:string;subjectType:'collection'|'node';subjectId:string;type:string;format:string|null;value:unknown }
export class ActorCollectionReadLimitError extends Error { readonly code='payload_too_large'; }
/** Effective collection membership is independent of any Digest membership. All methods share the caller transaction. */
export interface ActorCollectionReadPort {
  metadataMany(actor:CollectionReadActor,ids:readonly string[]):Promise<Map<string,ActorCollectionMetadata>>;
  metadata(actor:CollectionReadActor,id:string):Promise<ActorCollectionMetadata|null>;
  nodes(actor:CollectionReadActor,id:string,ids?:string[]):Promise<{meta:ActorCollectionMetadata;rows:ActorCollectionNode[]}|null>;
  annotations(actor:CollectionReadActor,id:string,nodes:readonly string[]):Promise<ActorCollectionAnnotation[]>;
}
