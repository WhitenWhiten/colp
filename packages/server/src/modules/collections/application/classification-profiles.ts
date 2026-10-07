import type {ProductCommandClaim,ProductCommandResult} from '../../commands/index.js';
export interface ClassificationProviderProfile {
  readonly profileId:string;readonly label:string;readonly kind:string;readonly protocol:string;readonly model:string;
  readonly capabilities:readonly ('folder_choice'|'tag_noul'|'confidence')[];readonly status:'active'|'disabled'|'test_failed';
  readonly endpointHost:string;readonly lastTestedAt:string|null;readonly createdAt:string;readonly updatedAt:string;readonly etag:string;
}
export class ClassificationProfileError extends Error {
  constructor(readonly code:'invalid_document'|'resource_not_found'|'mutation_conflict'|'feature_temporarily_unavailable'){
    super(code);this.name='ClassificationProfileError';
  }
}
export interface ClassificationProfileCommand {
  readonly actor:{readonly principalId:string;readonly subjectId:string};readonly commandId:string;readonly requestId:string;
  readonly profileId?:string;readonly ifMatch?:string;readonly document?:unknown;
}
export type ClassificationProfileResult=Exclude<ProductCommandClaim,{kind:'claimed'}>|{kind:'succeeded';result:ProductCommandResult};
export interface ClassificationProfilesRuntime {
  list(ownerSubjectId:string):Promise<{profiles:readonly ClassificationProviderProfile[];etag:string}>;
  create(input:ClassificationProfileCommand):Promise<ClassificationProfileResult>;
  update(input:ClassificationProfileCommand):Promise<ClassificationProfileResult>;
  delete(input:ClassificationProfileCommand):Promise<ClassificationProfileResult>;
  test(input:ClassificationProfileCommand):Promise<ClassificationProfileResult>;
  start():void;stop():Promise<void>;
}
