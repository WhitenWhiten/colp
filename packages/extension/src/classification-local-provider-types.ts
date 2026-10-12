import type {ClassificationCandidates} from './generated/classification/classification-candidates.js';
import type {ClassificationCandidateCoverage,ClassificationBookmark,ClassificationRequested,ClassificationFolderSelectionMode} from './generated/classification/classification-policy.js';
export interface ClassificationCallResult {readonly answer:unknown;readonly modelVersion:string;readonly inputTokens:number|null;readonly outputTokens:number|null;readonly attemptNumber?:number}
export interface LocalClassificationContext {
  readonly requested:ClassificationRequested;readonly candidates:ClassificationCandidates|null;
  readonly folderSelectionMode?:ClassificationFolderSelectionMode;
  readonly bookmark:ClassificationBookmark;readonly collection:{readonly title:string;readonly summary:string|null};
  readonly snapshot:{readonly node:{readonly tags:readonly string[]}|null;readonly settings:{readonly maxAutoTags:number}};
}
export interface BookmarkClassificationProvider {
  readonly id:string;readonly model:string;readonly policyVersion:string;readonly promptVersion:string;readonly capabilities:{readonly idempotency:false};
  classify(context:LocalClassificationContext,execution:{readonly signal:AbortSignal;readonly deadlineAt?:string;readonly calls:{
    run(stage:'l1'|'l2'|'tags',chunk:number,input:unknown,send:()=>Promise<ClassificationCallResult>):Promise<ClassificationCallResult>;
  }}):Promise<{l1:unknown;l2:unknown;tags:readonly unknown[];candidateCoverage:ClassificationCandidateCoverage;modelVersion:string|null}>;
}
export class ClassificationProviderError extends Error {constructor(readonly code:string,readonly attempts?:number){super(code);this.name='ClassificationProviderError';}}
