import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../sync-state/codec.js';
import type { BootstrapRunRecord, SyncScope } from '../sync-state/types.js';

export function bootstrapRunInFlight(phase: BootstrapRunRecord['phase']): boolean {
  return phase === 'confirmed' || phase === 'scanning' || phase === 'matching' || phase === 'syncing';
}

export function bootstrapOpId(confirmationId: string, kind: string, key: string): string {
  const encoded = `${bootstrapRunOpPrefix(confirmationId)}${kind}.${opaqueSegment(key)}`;
  if (encoded.length <= 128) return encoded;
  return `b3.${bytesToHex(sha256(new TextEncoder().encode(canonicalJson([confirmationId, kind, key]))))}`;
}

export function bootstrapRunOpPrefix(confirmationId: string): string {
  return `b3.${opaqueSegment(confirmationId)}.`;
}

export function mountResolveOpIdMatches(opId: string, key: string): boolean {
  return opId.includes('.mount.') && opId.endsWith(`.${opaqueSegment(key)}`);
}

function opaqueSegment(value: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9_-]/.test(char) ? char : `~${byte.toString(16).padStart(2, '0')}`;
  }
  return encoded;
}

/** Range bootstraps keep firstRun completed but still own their unmapped natives. */
export async function hasRunningBootstrap(store: {
  listBootstrapRuns(scope: SyncScope): Promise<readonly BootstrapRunRecord[]>;
}, scope: SyncScope): Promise<boolean> {
  return (await store.listBootstrapRuns(scope)).some(run => !run.previewOnly && bootstrapRunInFlight(run.phase));
}
