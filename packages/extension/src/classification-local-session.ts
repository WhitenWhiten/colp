import {classificationEndpointAllowed,classificationEndpointIsLoopback,localClassificationPreset,type LocalClassificationPresetId} from './classification-local-presets.js';
import { releaseClassificationOrigin, sharesHostPermission } from './classification-origin-permission.js';
export type {LocalClassificationPresetId} from './classification-local-presets.js';
export const LOCAL_CLASSIFICATION_ENABLED='known.classification.local-enabled.v1';
export const localClassificationAvailable=()=>typeof __KNOWN_EXTENSION_CLASSIFICATION_LOCAL__!=='undefined'&&__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__;
export async function localClassificationRequested(){return (await chrome.storage.local.get(LOCAL_CLASSIFICATION_ENABLED))[LOCAL_CLASSIFICATION_ENABLED]===true;}
/** Shared provider selection for popup suggestions and saved captures; key loss never selects cloud implicitly. */
export async function localClassificationEnabled(): Promise<boolean> {
  return localClassificationAvailable() && await localClassificationRequested().catch(() => false);
}
/** The provider key and configuration, kept in storage.local so it survives browser restarts. */
export const LOCAL_CLASSIFICATION_KEY='known.classification.local-key.v1';
/** A restored configuration has no secret or consent; it only pre-fills the connection form. */
export const LOCAL_CLASSIFICATION_DRAFT='known.classification.local-draft.v1';
/** Where earlier builds kept the key (cleared with the browser session); read once to migrate. */
const LEGACY_SESSION_KEY='known.classification.local-session.v1';
export const LOCAL_CLASSIFICATION_PROJECTION='known.classification.local-projection.v1';
export const LOCAL_CLASSIFICATION_COMMANDS='known.classification.local-commands.v1';
/** Kept for the Cloudflare preset's permission cleanup path. */
export const LOCAL_CLASSIFICATION_ORIGIN='https://api.cloudflare.com/*';
/** Last origin pattern granted for local classification, so it can be released when unused. */
export const LOCAL_CLASSIFICATION_GRANTED_ORIGIN='known.classification.local-origin.v1';

/**
 * Host permissions are granted per origin, so switching endpoints would otherwise
 * accumulate access. Call the request first (it needs the user gesture), then this.
 * A release that fails keeps the previous tracking value rather than forgetting it.
 */
export async function releaseStaleClassificationOrigin(activePattern:string):Promise<void>{
  const stored=(await chrome.storage.local.get(LOCAL_CLASSIFICATION_GRANTED_ORIGIN))[LOCAL_CLASSIFICATION_GRANTED_ORIGIN];
  let released=true;
  if(typeof stored==='string'&&stored&&!sharesHostPermission(stored,activePattern)){
    released=await releaseClassificationOrigin(stored);
  }
  if(released){
    if(activePattern)await chrome.storage.local.set({[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]:activePattern});
    else await chrome.storage.local.remove(LOCAL_CLASSIFICATION_GRANTED_ORIGIN);
  }
  if(!sharesHostPermission(LOCAL_CLASSIFICATION_ORIGIN,activePattern))await releaseClassificationOrigin(LOCAL_CLASSIFICATION_ORIGIN);
}

export function localClassificationOriginPattern(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}/*`;
}

/**
 * Local-first: the key belongs to this browser profile and the provider origin,
 * never to a Know-N account or collection, so it works signed out, survives
 * browser restarts and account or collection switches. storage.local is only
 * readable by extension pages and the worker (the extension has no content
 * scripts), and it never syncs across devices.
 */
export interface LocalClassificationCredential {
  readonly version: 3;
  readonly generation: string;
  readonly presetId: LocalClassificationPresetId;
  readonly endpoint: string;
  readonly model: string;
  readonly accountId?: string;
  readonly gatewayId?: string;
  readonly secret?: string;
  readonly disclosed: true;
}
/** Drops cached collection context and spent command markers; the saved key is kept. */
export async function clearLocalClassificationContext(){
  await chrome.storage.session.remove([LOCAL_CLASSIFICATION_PROJECTION,LOCAL_CLASSIFICATION_COMMANDS]);
}
/** Deletes the saved key too: only for a key that is malformed or being replaced. */
export async function clearLocalClassification(){
  await chrome.storage.local.remove(LOCAL_CLASSIFICATION_KEY);
  await chrome.storage.session.remove(LEGACY_SESSION_KEY);
  await clearLocalClassificationContext();
}
/** The stored configuration, unvalidated; moves a key an earlier build left in session storage. */
export async function storedLocalClassification():Promise<Partial<LocalClassificationCredential>|undefined>{
  const stored=(await chrome.storage.local.get(LOCAL_CLASSIFICATION_KEY))[LOCAL_CLASSIFICATION_KEY] as Partial<LocalClassificationCredential>|undefined;
  if(stored)return stored;
  const legacy=(await chrome.storage.session.get(LEGACY_SESSION_KEY).catch(()=>({})) as Record<string,unknown>)[LEGACY_SESSION_KEY] as Partial<LocalClassificationCredential>|undefined;
  if(!legacy)return undefined;
  await chrome.storage.local.set({[LOCAL_CLASSIFICATION_KEY]:legacy});
  await chrome.storage.session.remove(LEGACY_SESSION_KEY);
  return legacy;
}
/** Connection forms and backups can read a restored draft, while runtime requests require a real credential. */
export async function storedLocalClassificationForm(): Promise<Partial<LocalClassificationCredential> | undefined> {
  return await storedLocalClassification()
    ?? (await chrome.storage.local.get(LOCAL_CLASSIFICATION_DRAFT))[LOCAL_CLASSIFICATION_DRAFT] as Partial<LocalClassificationCredential> | undefined;
}
/** Offline readiness only relaxes the network gate; provider calls still validate credentials and host permission. */
export async function localClassificationCanRunOffline(): Promise<boolean> {
  try {
    const stored = await storedLocalClassification();
    return typeof stored?.endpoint === 'string' && classificationEndpointIsLoopback(stored.endpoint);
  } catch { return false; }
}
export async function localClassificationCredential():Promise<LocalClassificationCredential|null>{
  if(!await localClassificationEnabled())return null;
  const raw=await storedLocalClassification();
  if(!raw)return null;
  const preset=localClassificationPreset(raw.presetId??'');
  if(raw.version!==3||raw.disclosed!==true
    ||preset.id!==raw.presetId
    ||typeof raw.generation!=='string'||typeof raw.endpoint!=='string'
    ||typeof raw.model!=='string'||!raw.model.trim()){
    await clearLocalClassification();return null;
  }
  let originPattern: string;
  try {
    const url = new URL(raw.endpoint);
    if (!classificationEndpointAllowed(raw.endpoint) || !url.host) { await clearLocalClassification(); return null; }
    originPattern = `${url.origin}/*`;
  } catch {
    await clearLocalClassification();return null;
  }
  if(raw.secret!==undefined&&(typeof raw.secret!=='string'||new TextEncoder().encode(raw.secret).length>4096||/[\r\n\0]/u.test(raw.secret))){
    await clearLocalClassification();return null;
  }
  if(preset.credential==='required'&&(typeof raw.secret!=='string'||!raw.secret)){
    await clearLocalClassification();return null;
  }
  if(preset.accountFields){
    if(typeof raw.accountId!=='string'||!/^[a-f0-9]{32}$/iu.test(raw.accountId)
      ||typeof raw.gatewayId!=='string'||!/^[a-z0-9_-]{1,64}$/iu.test(raw.gatewayId)){
      await clearLocalClassification();return null;
    }
  }
  // Without the host grant (switched to server mode, or revoked in the browser) the
  // key stays saved but unusable; enabling local mode again requests the grant.
  if(!await chrome.permissions.contains({origins:[originPattern]}))return null;
  return raw as LocalClassificationCredential;
}
