import type { ProductOwnedCollectionsCursorConfig } from './config-types.js';
import {
  createCloudflareUpstream,
  MAX_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  MIN_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  type ClassificationUpstream,
} from '../infrastructure/collections/index.js';

export interface ClassifyInboxFeatureConfig {
  /** Exposure control only; classify routes stay registered while false (handlers 404). */
  readonly enabled: boolean;
  readonly cursor: ProductOwnedCollectionsCursorConfig;
}

export function loadClassificationConfig(env: NodeJS.ProcessEnv) {
  const read = (key: string, defaultValue = false) => {
    const value = (env[key] ?? String(defaultValue)).trim().toLowerCase();
    if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
    return value === 'true';
  };
  const providerName = (env.BOOKMARK_CLASSIFICATION_PROVIDER ?? 'cloudflare_jev').trim();
  if (providerName !== 'cloudflare_jev') throw new Error('Unsupported classification provider');
  const model = (env.BOOKMARK_CLASSIFICATION_MODEL ?? 'typesafe/jev').trim();
  // The model identifier is a free-form upstream identifier; only its shape is constrained.
  if (!model || /[\s\u0000-\u001f\u007f]/u.test(model)) throw new Error('Invalid classification model identifier');
  const accountId=env.BOOKMARK_CLASSIFICATION_CF_ACCOUNT_ID?.trim();
  const accessKey=env.BOOKMARK_CLASSIFICATION_CF_ACCESS_KEY?.trim();
  const gatewayId=env.BOOKMARK_CLASSIFICATION_CF_GATEWAY_ID?.trim()||'default';
  if((accountId||accessKey)&&(!accountId||!/^[a-f0-9]{32}$/i.test(accountId)||!accessKey||!/^[a-z0-9_-]{1,64}$/i.test(gatewayId)))throw new Error('Incomplete classification provider credentials');
  const endpoint = env.BOOKMARK_CLASSIFICATION_ENDPOINT?.trim();
  // Unset keeps alias semantics (record the reported version); set pins and verifies it.
  const expectedModelVersion = env.BOOKMARK_CLASSIFICATION_EXPECTED_MODEL_VERSION?.trim() || null;
  const requestTimeoutMs = parseClassificationRequestTimeoutMs(env.BOOKMARK_CLASSIFICATION_REQUEST_TIMEOUT_MS);
  const provider: ClassificationUpstream | null = accountId && accessKey ? createCloudflareUpstream({
    accountId,
    accessKey,
    gatewayId,
    endpoint: endpoint || undefined,
    model,
    expectedModelVersion,
    requestTimeoutMs,
  }) : null;
  const byokEnabled=read('KNOWN_FEATURE_CLASSIFICATION_BYOK');
  const creditEnabled=read('KNOWN_FEATURE_CLASSIFICATION_CREDITS');
  const secretKeys=parseClassificationSecretKeys(env.BOOKMARK_CLASSIFICATION_SECRET_KEYS);
  const fingerprintKey=env.BOOKMARK_CLASSIFICATION_SECRET_FINGERPRINT_KEY?decodeClassificationKey(env.BOOKMARK_CLASSIFICATION_SECRET_FINGERPRINT_KEY):null;
  // Missing keys disable secret operations at runtime; existing metadata remains readable.
  return Object.freeze({managedAdmissionEnabled:read('KNOWN_FEATURE_CLASSIFICATION_MANAGED_ADMISSION',true),creditEnabled,priorEnabled:read('KNOWN_FEATURE_CLASSIFICATION_HOSTNAME_PRIOR'),byokEnabled,secretKeys,fingerprintKey,autoTagsEnabled:read('KNOWN_FEATURE_CLASSIFICATION_AUTO_TAGS'),batchEnabled:read('KNOWN_FEATURE_CLASSIFICATION_BATCH'),enabled: read('KNOWN_FEATURE_CLASSIFICATION'), tagsEnabled: read('KNOWN_FEATURE_CLASSIFICATION_TAGS'),provider});
}

function decodeClassificationKey(value:string){
  const key=Buffer.from(value,'base64');
  if(key.length!==32||key.toString('base64')!==value)throw new Error('Invalid classification secret key configuration');return key;
}
function parseClassificationRequestTimeoutMs(value:string|undefined):number|undefined{
  if(value===undefined||value.trim()==='')return undefined;
  const parsed=Number(value.trim());
  if(!Number.isSafeInteger(parsed)||parsed<MIN_CLASSIFICATION_REQUEST_TIMEOUT_MS||parsed>MAX_CLASSIFICATION_REQUEST_TIMEOUT_MS)
    throw new Error('Invalid classification request timeout');
  return parsed;
}
function parseClassificationSecretKeys(value:string|undefined):readonly {id:string;version:number;key:Buffer}[]{
  if(!value)return [];
  try{
    const rows=JSON.parse(value) as unknown;
    if(!Array.isArray(rows)||rows.length<1||rows.length>8)throw new Error();
    const seen=new Set<string>();
    return rows.map(row=>{
      if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='id,key,version'||typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/u.test(row.id)
        ||!Number.isSafeInteger(row.version)||row.version<1||typeof row.key!=='string')throw new Error();
      const identity=`${row.id}:${row.version}`;if(seen.has(identity))throw new Error();seen.add(identity);
      return {id:row.id,version:row.version,key:decodeClassificationKey(row.key)};
    });
  }catch{throw new Error('Invalid classification secret key configuration');}
}
