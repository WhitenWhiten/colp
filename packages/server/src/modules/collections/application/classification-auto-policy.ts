import { CLASSIFICATION_POLICY } from './classification-policy.js';

export const CLASSIFICATION_TAG_SEMANTICS_VERSION='tag-semantics.v1';
/** Conservative code-label rule: numeric/punctuation-only or short ASCII code + digits.
 * Named technical labels such as AI, CSS3 and web3 remain meaningful candidates. */
export function isLowSemanticClassificationTag(tag:string):boolean{
  const value=tag.trim();return !/[\p{L}]/u.test(value)||/^[a-z]{1,2}[-_]?\d+$/iu.test(value);
}
export interface ClassificationAutoCalibration {
  readonly tagSemanticsVersion:string;
  readonly providerId:string;readonly model:string;readonly modelVersion:string;readonly policyVersion:string;readonly promptVersion:string;readonly candidateVersion:string;
  readonly threshold:number;readonly calibration:{readonly truePositives:number;readonly falsePositives:number};
  readonly holdout:{readonly truePositives:number;readonly falsePositives:number};
  readonly calibrationHash:string;readonly holdoutHash:string;readonly provenance:'human'|'synthetic_user_waiver';
}
/** EXP-02 did not pass the frozen gate. No deployment can silently invent an auto threshold. */
export const APPROVED_CLASSIFICATION_AUTO_CALIBRATION:ClassificationAutoCalibration|null=null;
export function autoPrecisionGate(counts:ClassificationAutoCalibration['holdout']):boolean {
  const {truePositives:tp,falsePositives:fp}=counts,n=tp+fp;
  if(!Number.isSafeInteger(tp)||!Number.isSafeInteger(fp)||tp<0||fp<0||!Number.isSafeInteger(n)||n<200)return false;
  const p=tp/n,z=1.959963984540054,z2=z*z;
  const lower=(p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n);
  return lower>=0.98;
}
export function eligibleAutoCalibration(value:ClassificationAutoCalibration|null,identity:{providerId:string;model:string;modelVersion:string;policyVersion:string;promptVersion:string;candidateVersion:string}):value is ClassificationAutoCalibration {
  return value!==null&&value.tagSemanticsVersion===CLASSIFICATION_TAG_SEMANTICS_VERSION&&[0.7,0.8,0.85,0.9].includes(value.threshold)
    &&/^[a-f0-9]{64}$/u.test(value.calibrationHash)&&/^[a-f0-9]{64}$/u.test(value.holdoutHash)&&value.calibrationHash!==value.holdoutHash
    &&['human','synthetic_user_waiver'].includes(value.provenance)&&autoPrecisionGate(value.calibration)&&autoPrecisionGate(value.holdout)
    &&Object.entries(identity).every(([key,entry])=>value[key as keyof typeof identity]===entry);
}
export function selectClassificationAutoTags(candidates:readonly {tag:string;noul:number}[],input:{
  readonly threshold:number;readonly maxAdded:number;readonly existingTags:readonly string[];readonly vocabulary:readonly string[];
}):readonly string[]{
  const room=Math.max(0,Math.min(CLASSIFICATION_POLICY.maxAddedTags,input.maxAdded,CLASSIFICATION_POLICY.maxFinalTags-input.existingTags.length));
  const known=new Set(input.vocabulary),existing=new Set(input.existingTags),seen=new Set<string>();
  return candidates.filter(candidate=>{
    if(isLowSemanticClassificationTag(candidate.tag)||!known.has(candidate.tag)||existing.has(candidate.tag)||seen.has(candidate.tag)||!Number.isFinite(candidate.noul)||candidate.noul<0||candidate.noul>1)return false;
    seen.add(candidate.tag);return candidate.noul>=input.threshold;
  }).sort((a,b)=>b.noul-a.noul).slice(0,room).map(candidate=>candidate.tag);
}
