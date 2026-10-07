import { expect,test } from 'vitest';
import { APPROVED_CLASSIFICATION_AUTO_CALIBRATION,CLASSIFICATION_POLICY,eligibleAutoCalibration,selectClassificationAutoTags,
  type ClassificationAutoCalibration } from '../../../src/modules/collections/index.js';
const identity={providerId:'fixture',model:'fixture',modelVersion:'v1',policyVersion:CLASSIFICATION_POLICY.version,
  promptVersion:CLASSIFICATION_POLICY.promptVersion,candidateVersion:CLASSIFICATION_POLICY.candidateVersion};
const calibration:ClassificationAutoCalibration={tagSemanticsVersion:'tag-semantics.v1',...identity,threshold:0.9,calibration:{truePositives:500,falsePositives:0},
  holdout:{truePositives:500,falsePositives:0},calibrationHash:'a'.repeat(64),holdoutHash:'b'.repeat(64),provenance:'synthetic_user_waiver'};
test('no deployment auto approval exists after the failed EXP-02 gate; counts and identity must independently match',()=>{
  expect(APPROVED_CLASSIFICATION_AUTO_CALIBRATION).toBeNull();
  expect(eligibleAutoCalibration(calibration,identity)).toBe(true);
  expect(eligibleAutoCalibration(null,identity)).toBe(false);
  for(const value of [{...calibration,holdout:{truePositives:100,falsePositives:0}},
    {...calibration,holdout:{truePositives:490,falsePositives:10}},
    {...calibration,calibrationHash:calibration.holdoutHash},{...calibration,threshold:0.95},
    {...calibration,modelVersion:'changed'},{...calibration,policyVersion:'changed'}])expect(eligibleAutoCalibration(value,identity)).toBe(false);
});
test('automatic tags are exact existing-vocabulary additions, at most three and within the 64-tag final cap',()=>{
  const candidates=[{tag:'AI',noul:0.99},{tag:'ai',noul:0.98},{tag:'AI',noul:0.97},{tag:'invented',noul:1},{tag:'low',noul:0.8}];
  expect(selectClassificationAutoTags(candidates,{threshold:0.9,maxAdded:3,existingTags:['AI'],vocabulary:['AI','ai','low']})).toEqual(['ai']);
  expect(selectClassificationAutoTags(candidates,{threshold:0.9,maxAdded:3,existingTags:Array.from({length:64},(_,i)=>String(i)),vocabulary:['AI','ai']})).toEqual([]);
  expect(selectClassificationAutoTags(candidates,{threshold:0.9,maxAdded:0,existingTags:[],vocabulary:['AI','ai']})).toEqual([]);
});

test('opaque code labels cannot be auto-added even at perfect confidence',()=>{
  const tags=['t1','x-17','42','---','AI','CSS3','web3','机器学习'];
  expect(selectClassificationAutoTags(tags.map(tag=>({tag,noul:1})),{threshold:0.9,maxAdded:3,existingTags:[],vocabulary:tags})).toEqual(['AI','CSS3','web3']);
  expect(eligibleAutoCalibration({...calibration,tagSemanticsVersion:'obsolete'},identity)).toBe(false);
});
