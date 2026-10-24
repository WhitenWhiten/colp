import { identityDefinition } from './registry.js';
import type { AdapterManifest } from './contracts.js';
import { array, jsonBytes, literal, object, str } from './schema.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export const COMMUNITY_PACKAGE_BYTES = 512 * 1024;
export interface CommunityPackage { manifest: AdapterManifest; provenance: { maintainer: string; revision: string; sourceUrl: string }; script: string }
export interface PackagePreview { digest: string; text: string; package: CommunityPackage; bytes: number }
const httpsSource = (v: unknown) => {
  if (!str(2048)(v)) return false;
  try { const u = new URL(v as string); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
};
/** Data validation only: no compiler, eval, imports, install hooks or privileged execution. */
export function inspectCommunityPackage(text: string): PackagePreview {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > COMMUNITY_PACKAGE_BYTES) throw new Error('packageTooLarge');
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text) throw new Error('packageInvalidEncoding');
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('packageInvalid'); }
  if (!jsonBytes(value, COMMUNITY_PACKAGE_BYTES) || !object({
    manifest: object({ apiVersion: literal('known.site-adapter/v1'), adapterId: v => typeof v === 'string' && /^community\.[a-z0-9][a-z0-9.-]{0,62}$/u.test(v),
      version: v => typeof v === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(v), siteKey: str(128), identityVersion: v => Number.isSafeInteger(v) && Number(v) > 0,
      matches: array(str(2048), 16, 1, v => v),
      execution: object({ mode: literal('userScript'), entry: literal('adapter.js'), runAt: literal('document_start', 'document_idle') }),
      capabilities: array(literal('observeFavorites'), 1, 1) }),
    provenance: object({ maintainer: str(256), revision: v => v === 'local' || typeof v === 'string' && /^[a-f0-9]{40,64}$/u.test(v), sourceUrl: httpsSource }),
    script: str(256 * 1024),
  })(value) || new TextEncoder().encode((value as CommunityPackage).script).byteLength > 256 * 1024) throw new Error('packageUnsupported');
  const pkg = value as CommunityPackage;
  let definition; try { definition = identityDefinition(pkg.manifest.siteKey, pkg.manifest.identityVersion); } catch { throw new Error('packageUnsupported'); }
  if (!definition.community || JSON.stringify(pkg.manifest.matches) !== JSON.stringify(definition.matches)) throw new Error('packageUnsupported');
  return { digest: `sha256:${bytesToHex(sha256(bytes))}`, text, package: value as CommunityPackage, bytes: bytes.byteLength };
}
export const COMMUNITY_RISK = 'This code can read and alter authorized site pages, make requests using the site session, and expose visible private content. Install only code and authors you trust. You are responsible for this choice. Inspector mode blocks host writes, but does not make unknown page code safe.';
