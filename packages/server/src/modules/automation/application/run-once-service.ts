import type { Run,RunOncePreview } from '@know-n/colp/automation';
export interface RunOnceService {
  authorizePreview(previewId:string):Promise<void>;
  preview(ruleId:string,input:unknown):Promise<RunOncePreview>;
  start(ruleId:string,input:unknown):Promise<Run>;
}
