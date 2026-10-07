import {isAcceptedBookmarkUrl} from '../domain/bookmark-url.js';
import type {ClassificationFolderDecision} from './classification-decision.js';
import {compareClassificationBytes} from './classification-text.js';
export const CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION='classification.v2.hostname-tiebreak.v1';
/** No real explicit-decision holdout has passed EXP-03. The deployment gate stays closed. */
export interface ClassificationPriorEvaluation {
  readonly providerId:string;readonly model:string;readonly modelVersion:string;readonly policyVersion:string;readonly promptVersion:string;readonly candidateVersion:string;
  readonly holdoutHash:string;readonly registrationHash:string;readonly provenance:'explicit_user_commands';readonly holdoutBookmarks:number;
  readonly rankAccuracyGainPp:number;readonly laterToFolderIncreasePp:number;readonly pairedPValue:number;readonly acceptedDecisions:number;readonly collectionIsolationVerified:true;
}
export const APPROVED_CLASSIFICATION_PRIOR_EVALUATION:ClassificationPriorEvaluation|null=null;
export function eligibleClassificationPriorEvaluation(evaluation:ClassificationPriorEvaluation|null,identity:Pick<ClassificationPriorEvaluation,'providerId'|'model'|'modelVersion'|'promptVersion'|'candidateVersion'>):boolean {
  if(!evaluation||evaluation.provenance!=='explicit_user_commands'||evaluation.collectionIsolationVerified!==true||evaluation.policyVersion!==CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION)return false;
  if(Object.entries(identity).some(([key,value])=>evaluation[key as keyof typeof identity]!==value))return false;
  return /^[a-f0-9]{64}$/u.test(evaluation.holdoutHash)&&/^[a-f0-9]{64}$/u.test(evaluation.registrationHash)
    &&Number.isSafeInteger(evaluation.holdoutBookmarks)&&evaluation.holdoutBookmarks>=200
    &&Number.isSafeInteger(evaluation.acceptedDecisions)&&evaluation.acceptedDecisions>=5
    &&Number.isFinite(evaluation.rankAccuracyGainPp)&&evaluation.rankAccuracyGainPp>=2&&evaluation.rankAccuracyGainPp<=100
    &&Number.isFinite(evaluation.laterToFolderIncreasePp)&&evaluation.laterToFolderIncreasePp<=1&&evaluation.laterToFolderIncreasePp>=-100
    &&Number.isFinite(evaluation.pairedPValue)&&evaluation.pairedPValue>=0&&evaluation.pairedPValue<0.05;
}
export interface ClassificationHostnameEvidence {
  readonly hostname:string;readonly folderId:string;readonly acceptedCount:number;readonly currentRevisionCount:number;
  readonly rejectedCount:null;readonly lastAcceptedAt:string;
}
export interface ClassificationEvidencePort {
  append(input:{readonly ownerSubjectId:string;readonly collectionId:string;readonly nodeId:string;readonly folderId:string|null;
    readonly addTags:readonly string[];readonly source:'classify_accept'|'run_apply';readonly commandId:string;
    readonly taxonomyRevision:string;readonly operationId?:string}):Promise<void>;
}
export function normalizeClassificationHostname(value:string):string|null {
  if(!isAcceptedBookmarkUrl(value))return null;
  const hostname=new URL(value).hostname.toLowerCase().replace(/\.$/u,'').replace(/^www\./u,'');
  if(hostname==='localhost'||hostname.endsWith('.localhost')||hostname.includes(':')||/^\d+(?:\.\d+){3}$/u.test(hostname)
    ||hostname.length>253||hostname.split('.').some(label=>!label||label.length>63||!(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))))return null;
  return hostname;
}
export function eligibleClassificationHostnameFolder(evidence:readonly ClassificationHostnameEvidence[],url:string):string|null {
  const hostname=normalizeClassificationHostname(url);if(!hostname)return null;
  const rows=evidence.filter(row=>row.hostname===hostname);
  if(rows.some(row=>!Number.isSafeInteger(row.acceptedCount)||row.acceptedCount<1||!Number.isSafeInteger(row.currentRevisionCount)
    ||row.currentRevisionCount<0||row.currentRevisionCount>row.acceptedCount))return null;
  if(new Set(rows.map(row=>row.folderId)).size!==rows.length||rows.reduce((sum,row)=>sum+row.acceptedCount,0)<5)return null;
  // Old taxonomy revisions carry one quarter of current evidence weight. Never inflate provider confidence.
  const ranked=rows.map(row=>({folderId:row.folderId,weight:row.currentRevisionCount+(row.acceptedCount-row.currentRevisionCount)*0.25}))
    .sort((a,b)=>b.weight-a.weight||compareClassificationBytes(a.folderId,b.folderId));
  const total=ranked.reduce((sum,row)=>sum+row.weight,0),top=ranked[0];if(!top||!total)return null;
  return top.weight/total>=0.7&&(top.weight-(ranked[1]?.weight??0))/total>=0.2?top.folderId:null;
}
/** Only reorder equal model probabilities already returned by the provider. No inferred move or score inflation. */
export function rankClassificationHostnameTies(decision:ClassificationFolderDecision|null,evidence:readonly ClassificationHostnameEvidence[],url:string):ClassificationFolderDecision|null {
  if(!decision)return null;
  const preferred=eligibleClassificationHostnameFolder(evidence,url);if(!preferred)return decision;
  return {...decision,probabilities:decision.probabilities.map((probability,index)=>({probability,index})).sort((a,b)=>
    b.probability.probability-a.probability.probability||Number(b.probability.folderId===preferred)-Number(a.probability.folderId===preferred)||a.index-b.index)
    .map(row=>row.probability)};
}
