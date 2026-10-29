import { bundledSites, type SiteDefinition } from './registry.js';
import type { CommunityInstallation } from './community-state.js';
import { validateSiteDefinitions } from './registry-validation.js';
import { communitySiteDefinition, itemUrlCodec, type CommunityManifest } from './community-definition.js';
import { array, integer, jsonBytes, literal, object, optional, str } from './schema.js';
import { validAdapterIcon } from './icon-spec.js';
import { validSiteTitle } from './title.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export const COMMUNITY_PACKAGE_BYTES = 512 * 1024;
export interface CommunityPackage { manifest: CommunityManifest; provenance: { maintainer: string; revision: string; sourceUrl: string }; script: string }
export interface PackagePreview { digest: string; text: string; package: CommunityPackage; bytes: number }
const httpsSource = (v: unknown) => {
  if (!str(2048)(v)) return false;
  try { const u = new URL(v as string); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
};
/** Chrome match patterns restricted to explicit HTTPS hosts. */
const siteMatch = (v: unknown) => {
  if (!str(2048)(v) || typeof v !== 'string' || !/^https:\/\/[^/*?#:]+\/[^?#]*$/u.test(v)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hostname.includes('*'); } catch { return false; }
};
const httpsOrigin = (v: unknown) => {
  if (!str(2048)(v)) return false;
  try { const u = new URL(v as string); return u.protocol === 'https:' && u.origin === v; } catch { return false; }
};
const readPolicyKeys = ['spacingMs', 'commandMs', 'activationMs', 'commandAttempts', 'requestSpacingMs', 'requestMs', 'attempts', 'backoffMs', 'maxAutomaticWaitMs', 'responseBytes'];
const manifestSchema = object({
  apiVersion: literal('known.site-adapter/v1'), adapterId: v => typeof v === 'string' && /^community\.[a-z0-9][a-z0-9.-]{0,62}$/u.test(v),
  version: v => typeof v === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(v), label: v => validSiteTitle(v) && (v as string).length <= 64,
  siteKey: v => typeof v === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/u.test(v), identityVersion: v => Number.isSafeInteger(v) && Number(v) > 0,
  matches: array(siteMatch, 16, 1, v => v),
  execution: object({ mode: literal('userScript'), entry: literal('adapter.js'), runAt: literal('document_start', 'document_idle') }),
  capabilities: array(literal('observeFavorites', 'resolveItem', 'readMemberships', 'enumerateCollections', 'enumerateItems'), 5, 1, v => v),
  icon: optional(validAdapterIcon),
  defaultCollection: optional(object({ id: str(128), title: validSiteTitle })),
  itemUrl: optional(v => typeof v === 'string' && !!itemUrlCodec(v)),
  connectOrigins: optional(array(httpsOrigin, 16, 1, v => v)),
  connectionKind: optional(literal('account', 'page')), readScope: optional(literal('document', 'account')),
  contentIdScope: optional(literal('site', 'account')), collectionSnapshot: optional(literal('positiveOnly', 'pointInTime')),
  negativeReadback: optional(literal(true, false)), importResume: optional(literal('stableCursor', 'restartAndDeduplicate')),
  readPolicy: optional(object(Object.fromEntries(readPolicyKeys.map(key => [key, optional(integer)])))),
});
/** Data validation only: no compiler, eval, imports, install hooks or privileged execution. */
export function inspectCommunityPackage(text: string): PackagePreview {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > COMMUNITY_PACKAGE_BYTES) throw new Error('packageTooLarge');
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text) throw new Error('packageInvalidEncoding');
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('packageInvalid'); }
  if (!jsonBytes(value, COMMUNITY_PACKAGE_BYTES) || !object({
    manifest: manifestSchema,
    provenance: object({ maintainer: str(256), revision: v => v === 'local' || typeof v === 'string' && /^[a-f0-9]{40,64}$/u.test(v), sourceUrl: httpsSource }),
    script: str(256 * 1024),
  })(value) || new TextEncoder().encode((value as CommunityPackage).script).byteLength > 256 * 1024) throw new Error('packageUnsupported');
  const pkg = value as CommunityPackage;
  // The same registry rules as a bundled site, including a siteKey/identityVersion no bundled site already uses.
  validateSiteDefinitions([...bundledSites, communitySiteDefinition(pkg.manifest)]);
  return { digest: `sha256:${bytesToHex(sha256(bytes))}`, text, package: pkg, bytes: bytes.byteLength };
}
/** A package's site, or null when its reviewed bytes no longer pass the current format (such as a removed hint-only package). */
export function installedSite(row: CommunityInstallation): SiteDefinition | null {
  try { const parsed = inspectCommunityPackage(row.approved.text); return parsed.digest === row.approved.digest ? communitySiteDefinition(parsed.package.manifest) : null; }
  catch { return null; }
}
/** The packages that can run, in install order; a row whose site identity another row already holds is left out. */
export function installedSites(rows: readonly CommunityInstallation[]) {
  const sites: { row: CommunityInstallation; definition: SiteDefinition }[] = [];
  for (const row of rows) {
    const definition = installedSite(row); if (!definition) continue;
    try { validateSiteDefinitions([...bundledSites, ...sites.map(s => s.definition), definition]); sites.push({ row, definition }); } catch { /* listed with an error */ }
  }
  return sites;
}
export const COMMUNITY_RISK = 'This code can read and alter authorized site pages, make requests using the site session, and expose visible private content. Install only code and authors you trust. You are responsible for this choice. Once you turn the site on, what it reports becomes bookmarks in the folder you choose.';
