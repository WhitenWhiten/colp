import { assertCanonicalCommandId, canonicalCommandFingerprint, canonicalJson, type ProductCommandReceiptPort } from '../../commands/index.js';
import { CollectionPreconditionError } from '../domain/index.js';

export interface ClassificationSettingsValues {
  readonly autoTagMode: 'off' | 'suggest' | 'auto';
  readonly maxAutoTags: number;
  readonly executionMode: 'server_managed'|'server_byok';
  readonly providerProfileId: string|null;
}
export interface ClassificationSettings extends ClassificationSettingsValues {
  readonly contractVersion: '1.0.0'|'2.0.0'; readonly collectionId: string;
  readonly revision: string; readonly updatedAt: string;
}
export type ClassificationSettingsPatch = Partial<ClassificationSettingsValues>;
export class ClassificationSettingsError extends Error {
  constructor(readonly code: 'invalid_document' | 'resource_not_found') { super(code); this.name = 'ClassificationSettingsError'; }
}
export interface ClassificationSettingsStore {
  loadOwned(input: { readonly collectionId: string; readonly ownerSubjectId: string }): Promise<ClassificationSettings | null>;
  compareAndSet(input: { readonly current: ClassificationSettings; readonly values: ClassificationSettingsValues; readonly ownerSubjectId: string }): Promise<ClassificationSettings | null>;
}
export interface ClassificationSettingsPorts { readonly settings: ClassificationSettingsStore; readonly receipts: ProductCommandReceiptPort }
export interface ClassificationSettingsUnitOfWork {
  execute<T>(work: (ports: ClassificationSettingsPorts) => Promise<T>): Promise<T>;
}
/** Tag suggestions are allowed by default; each request (the user's own tag preference) decides whether to ask. */
export const DEFAULT_CLASSIFICATION_SETTINGS: ClassificationSettingsValues = Object.freeze({ autoTagMode: 'suggest', maxAutoTags: 3, executionMode: 'server_managed', providerProfileId: null });
export const classificationSettingsEtag = (settings: ClassificationSettings) => `"classification-settings:${settings.collectionId}:${settings.revision}"`;

export function parseClassificationSettingsPatch(value: unknown, capabilities:{readonly auto?:boolean;readonly byok?:boolean}={}): ClassificationSettingsPatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ClassificationSettingsError('invalid_document');
  const raw = value as Record<string, unknown>; const keys = Object.keys(raw);
  if (!keys.length || keys.some(key => !Object.hasOwn(DEFAULT_CLASSIFICATION_SETTINGS, key))) throw new ClassificationSettingsError('invalid_document');
  if (Object.hasOwn(raw, 'autoTagMode') && raw.autoTagMode !== 'off' && raw.autoTagMode !== 'suggest' && !(capabilities.auto && raw.autoTagMode === 'auto')) throw new ClassificationSettingsError('invalid_document');
  if (Object.hasOwn(raw, 'maxAutoTags') && (typeof raw.maxAutoTags !== 'number' || !Number.isInteger(raw.maxAutoTags) || raw.maxAutoTags < 0 || raw.maxAutoTags > 3)) throw new ClassificationSettingsError('invalid_document');
  if (Object.hasOwn(raw, 'executionMode') && raw.executionMode !== 'server_managed' && !(capabilities.byok&&raw.executionMode==='server_byok')) throw new ClassificationSettingsError('invalid_document');
  if (Object.hasOwn(raw, 'providerProfileId') && raw.providerProfileId !== null && !(capabilities.byok&&typeof raw.providerProfileId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(raw.providerProfileId))) throw new ClassificationSettingsError('invalid_document');
  return raw as ClassificationSettingsPatch;
}

export async function updateClassificationSettings(ports: ClassificationSettingsPorts, input: {
  readonly actor: { readonly principalId: string; readonly subjectId: string }; readonly collectionId: string;
  readonly v2?:boolean;readonly autoEnabled?:boolean;
  readonly commandId: string; readonly ifMatch: string; readonly patch: ClassificationSettingsPatch;
}) {
  const patch = parseClassificationSettingsPatch(input.patch,{byok:input.v2,auto:input.v2&&input.autoEnabled});
  const commandId = assertCanonicalCommandId(input.commandId);
  const current = await ports.settings.loadOwned({collectionId: input.collectionId, ownerSubjectId: input.actor.subjectId});
  if (!current) throw new ClassificationSettingsError('resource_not_found');
  const binding = {principalId: input.actor.principalId, commandScope: 'collections:classification-settings:v1', commandId};
  const fingerprint = canonicalCommandFingerprint({method: 'PATCH', route: `/api/v1/collections/${input.collectionId}/classification-settings`, mediaType: input.v2?CLASSIFICATION_SETTINGS_V2_MEDIA:'application/json', body: canonicalJson(patch),...(input.v2?{conditions:{ifMatch:input.ifMatch}}:{})});
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind === 'replay') return {kind: 'replay' as const, ...claim.result};
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return {kind: 'expired' as const};
  if (claim.kind !== 'claimed') return {kind: 'reused' as const};
  if(!input.v2&&(current.executionMode!=='server_managed'||current.autoTagMode==='auto'))throw new ClassificationSettingsError('resource_not_found');
  if (input.ifMatch !== classificationSettingsEtag(current)) throw new CollectionPreconditionError({ currentEtag: classificationSettingsEtag(current), precondition: 'resource', message: 'Classification settings have changed.' });
  const values: ClassificationSettingsValues = {autoTagMode: patch.autoTagMode ?? current.autoTagMode, maxAutoTags: patch.maxAutoTags ?? current.maxAutoTags, executionMode: patch.executionMode??current.executionMode, providerProfileId: Object.hasOwn(patch,'providerProfileId')?patch.providerProfileId!:current.providerProfileId};
  if((values.executionMode==='server_managed')!==(values.providerProfileId===null))throw new ClassificationSettingsError('invalid_document');
  const unchanged = current.revision !== '0' && current.autoTagMode === values.autoTagMode && current.maxAutoTags === values.maxAutoTags && current.executionMode===values.executionMode && current.providerProfileId===values.providerProfileId;
  const stored = unchanged ? current : await ports.settings.compareAndSet({current, values, ownerSubjectId: input.actor.subjectId});
  if (!stored) throw new CollectionPreconditionError({currentEtag: classificationSettingsEtag(current), precondition: 'resource', message: 'Classification settings have changed.'});
  const settings:ClassificationSettings={...stored,contractVersion:input.v2?'2.0.0':'1.0.0'};
  const mediaType=input.v2?CLASSIFICATION_SETTINGS_V2_MEDIA:'application/json';
  const result = {status: 200, body: Buffer.from(JSON.stringify(settings)), mediaType, contractVersion: settings.contractVersion,
    stableHeaders: {'content-type': `${mediaType}; charset=utf-8`, 'cache-control': 'private, no-store', etag: classificationSettingsEtag(settings)}};
  await ports.receipts.complete(binding, fingerprint, result);
  return {kind: 'succeeded' as const, settings};
}

export const CLASSIFICATION_SETTINGS_V2_MEDIA='application/vnd.known.classification-settings.v2+json';
