import {createCloudflareJevClassificationProvider, createClassificationUpstream} from './generated/classification/classification-provider-cloudflare-jev.js';
import {localClassificationPreset} from './classification-local-presets.js';
import {CLASSIFICATION_POLICY,buildClassificationCandidates,normalizeClassificationBookmark,compileClassificationText,
  decideClassificationFolder,decideClassificationTags} from './generated/classification/index.js';
import type {ClassificationPreviewRequest,ClassificationPreviewResponse} from './classification-product-client.js';
import {LOCAL_CLASSIFICATION_COMMANDS,type LocalClassificationCredential} from './classification-local-session.js';
import type {ClassificationFolderInput,ClassificationTagUsage} from './generated/classification/classification-policy.js';
/**
 * What the provider chooses from. Folder ids are whatever the caller can act on
 * (native bookmark ids for local mode); the collection fields are optional
 * context a synced collection can add.
 */
export interface LocalClassificationTaxonomy {
  readonly folders:readonly ClassificationFolderInput[];readonly tagUsage:readonly ClassificationTagUsage[];
  readonly title:string;readonly summary:string|null;readonly revision:string;readonly collectionId:string;
}
/** Dispatched by a user action or an explicitly enabled host task. A spent attempt never retries automatically. */
export async function previewLocalClassification(input:{credential:LocalClassificationCredential;taxonomy:LocalClassificationTaxonomy;
  document:ClassificationPreviewRequest;commandId:string;signal:AbortSignal;assertCurrent:()=>Promise<void>;transport?:typeof fetch}):Promise<ClassificationPreviewResponse>{
  if(!('bookmark' in input.document))throw new Error('local_incoming_only');
  const {credential,taxonomy:projection,document}=input;
  await input.assertCurrent();
  const prior=(await chrome.storage.session.get(LOCAL_CLASSIFICATION_COMMANDS))[LOCAL_CLASSIFICATION_COMMANDS] as {generation:string;commands:string[]}|undefined;
  const commands=prior?.generation===credential.generation?prior.commands:[];
  if(commands.includes(input.commandId))throw new Error('local_result_unavailable');
  if(commands.length>=100)throw new Error('local_session_budget_exhausted');
  // Persist before any network side effect. A worker restart cannot repeat this command.
  await chrome.storage.session.set({[LOCAL_CLASSIFICATION_COMMANDS]:{generation:credential.generation,commands:[...commands,input.commandId]}});
  const requested={folder:'folder' in document.requested&&document.requested.folder===true,tags:'tags' in document.requested&&document.requested.tags===true},bookmark=normalizeClassificationBookmark(document.bookmark);
  const candidates=buildClassificationCandidates({bookmark,folders:projection.folders,tagUsage:projection.tagUsage,existingTags:[],requested,
    rejectedFolderIds:document.rejectedFolderIds});
  const preset=localClassificationPreset(credential.presetId);
  const upstream=createClassificationUpstream({
    id:preset.id==='cloudflare'?'cloudflare_jev':preset.id,
    wire:preset.wire,
    endpoint:credential.endpoint,model:credential.model,accountId:credential.accountId,
    gatewayId:credential.gatewayId,accessKey:credential.secret??'',
    // Alias semantics: the session credential carries no pinned version, and pinning the
    // default one would reject every other model the user is allowed to configure.
    expectedModelVersion:null,
    // Hosted presets always need their token; a custom endpoint may be anonymous.
    credentialRequired:preset.credential==='required',
  });
  const provider=createCloudflareJevClassificationProvider(upstream,input.transport);
  const context={bookmark,requested,candidates,folderSelectionMode:document.folderSelectionMode,collection:{title:compileClassificationText(projection.title,CLASSIFICATION_POLICY.titleBytes),
    summary:projection.summary===null?null:compileClassificationText(projection.summary,CLASSIFICATION_POLICY.summaryBytes)},snapshot:{node:null,settings:{maxAutoTags:3}}};
  const signal=AbortSignal.any([input.signal,AbortSignal.timeout(20000)]),called=new Set<string>();
  const result=await provider.classify(context,{signal,calls:{async run(stage,chunk,_body,send){
    await input.assertCurrent();signal.throwIfAborted();const key=`${stage}:${chunk}`;
    if(called.has(key))throw new Error('local_duplicate_dispatch');called.add(key);return send();
  }}});
  await input.assertCurrent();signal.throwIfAborted();
  const folder=decideClassificationFolder({candidates,bookmark,requested:requested.folder,l1:result.l1,l2:result.l2,folderSelectionMode:document.folderSelectionMode});
  const tags=decideClassificationTags({candidates:candidates.tags,existingTags:[],output:result.tags,maxAdded:3});
  return {contractVersion:'1.0.0',collectionId:projection.collectionId,source:{kind:'incoming',nodeId:null},taxonomyRevision:projection.revision,
    candidateCoverage:result.candidateCoverage,folder:folder?{...folder,probabilities:[...folder.probabilities]}:null,tags:{mode:requested.tags?'suggest':'off',candidates:tags.slice(0,15),maxAutoTags:3},
    provider:{providerId:provider.id,model:provider.model,policyVersion:provider.policyVersion,promptVersion:provider.promptVersion}};
}
