import type { Page } from '@playwright/test';
import { virtualNativeId } from '../src/projection-native-occupancy.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { safeDiagnosticCode, secretMetadata } from './mv3-multi-device-recovery-redaction.js';

type PullEvent = { state?: string; ordinal?: number; pendingMappings?: MappingInput[];
  pendingDeleteNativeIds?: string[]; payload?: { effect?: { kind?: string } } };
type Projection = { kind?: string; intentKind?: string; state?: string; colpId?: string;
  nativeId?: string; observedNativeId?: string; generation?: number };

/** Read-only identity joins. No titles, URLs, native IDs, Node IDs or tokens enter the artifact. */
export async function nativeIdentityDiagnostics(page: Page, readStore: (name: string) => Promise<unknown[]>) {
  const [rawMappings, rawEvents, rawIntents, nativeIds] = await Promise.all([
    readStore('native_mappings'), readStore('pull_events'), readStore('diagnostics'),
    page.evaluate(async () => {
      const flatten = (nodes: chrome.bookmarks.BookmarkTreeNode[]): string[] =>
        nodes.flatMap((node) => [node.id, ...flatten(node.children ?? [])]);
      return flatten(await chrome.bookmarks.getTree());
    }),
  ]);
  const mappings = rawMappings as Array<MappingInput & { scopeKey: string }>;
  const events = rawEvents as PullEvent[];
  const intents = (rawIntents as Projection[]).filter((row) => row.kind === 'projection_intent');
  const present = new Set(nativeIds);
  const missing = mappings.filter((row) => !virtualNativeId(row.nativeId) && !present.has(row.nativeId));
  return {
    mappingCount: mappings.length, virtualCount: mappings.filter((row) => virtualNativeId(row.nativeId)).length,
    missingCount: missing.length, omittedMissingCount: Math.max(0, missing.length - 50),
    missing: missing.slice(0, 50).map((mapping) => ({
      native: secretMetadata(mapping.nativeId, 'recovery-native-id'),
      node: secretMetadata(mapping.colpId, 'recovery-node-id'),
      scope: secretMetadata(mapping.scopeKey, 'recovery-scope-key'),
      kind: safeDiagnosticCode(mapping.nodeKind),
      parentNativePresent: present.has(mapping.parentNativeId ?? ''),
      rootNativePresent: present.has(mapping.rootNativeId),
      pullEvents: events.filter((event) => event.pendingMappings?.some((row) => row.colpId === mapping.colpId)
        || event.pendingDeleteNativeIds?.includes(mapping.nativeId)).map((event) => ({
        state: safeDiagnosticCode(event.state), ordinal: event.ordinal, kind: safeDiagnosticCode(event.payload?.effect?.kind),
        writesNative: event.pendingMappings?.some((row) => row.nativeId === mapping.nativeId) === true,
        deletesNative: event.pendingDeleteNativeIds?.includes(mapping.nativeId) === true,
      })),
      projectionIntents: intents.filter((intent) => intent.colpId === mapping.colpId).map((intent) => ({
        kind: safeDiagnosticCode(intent.intentKind), state: safeDiagnosticCode(intent.state), generation: intent.generation,
        targetsNative: intent.nativeId === mapping.nativeId, observedNative: intent.observedNativeId === mapping.nativeId,
      })),
    })),
  };
}
