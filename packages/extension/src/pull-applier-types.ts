import type { StrictNode } from '@know-n/colp/types';
import type { JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

import type { NativeWriteCheck } from './native-call-result.js';

export interface PullBookmarkApi {
  /** This adapter accepts a final check after its own asynchronous admission. */
  readonly nativeWriteChecks?: true;
  create(input: { parentId?: string; index?: number; title?: string; url?: string;
  }, beforeNative?: NativeWriteCheck): Promise<{ readonly id: string }>;
  update(id: string, changes: { title?: string; url?: string }, beforeNative?: NativeWriteCheck): Promise<unknown>;
  move(id: string, destination: { parentId?: string; index?: number }, beforeNative?: NativeWriteCheck): Promise<unknown>;
  remove(id: string, beforeNative?: NativeWriteCheck): Promise<void>;
  removeTree(id: string, beforeNative?: NativeWriteCheck): Promise<void>;
  get(id: string): Promise<readonly { readonly id: string; readonly parentId?: string; readonly index?: number;
    readonly title?: string; readonly url?: string; readonly unmodifiable?: string }[]>;
  getChildren(id: string): Promise<readonly { readonly id: string; readonly parentId?: string; readonly index?: number;
    readonly title?: string; readonly url?: string; readonly unmodifiable?: string }[]>;
}

export interface PullApplierOptions {
  readonly settleNativeEvents?: () => Promise<void>;
  readonly repairOwnCreate?: (mapping: MappingInput, parent: MappingInput) => Promise<void>;
  readonly assertCurrent?: () => Promise<void>;
  readonly scope: SyncScope; readonly store: ReturnType<typeof createSyncStateStore>; readonly api?: PullBookmarkApi;
  readonly session: { readonly acceptedProtocolVersion?: string; readonly sessionId: string;
    readonly collectionId: string; readonly conversionPolicy?: { readonly separator: string };
  readonly transportBudget?: { readonly pullResponseBytes: number; readonly snapshotPageBytes: number;
      readonly effectPageBytes: number; readonly effectAggregateBytes: number } };
  readonly effectPageTemplate: string; readonly effectPageAuthority: string; readonly now?: () => number;
  readonly endpoints?: { readonly syncPull: string; readonly syncEffectPages: string }; readonly credential?: { readonly accessToken: string };
  readonly origin?: string; readonly fetch?: typeof fetch; readonly crash?: (boundary: string) => void;
}

export type NativeEvent = { readonly kind: 'create' | 'change' | 'move' | 'remove'; readonly nativeId: string;
  readonly details: JsonObject };
export type PullNode = StrictNode;
export interface PullCursorAuthority { readonly reissued?: boolean }
