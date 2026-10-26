import type { CaptureScope, CaptureSource } from '../capture/contracts.js';
import type { NativeBinding, SavePlan, SaveEffect, RepresentationKey } from './contracts.js';
export interface StoredSavePlan { plan: SavePlan; digest: string; state: 'draft' | 'approved' | 'cancelled' }
export interface PlannedNativeCommand {
  commandId: string; kind: 'folder' | 'bookmark'; ownerId: string; logicalDigest: string; connectionId: string;
  parent: NativeBinding<'folder'>; title: string; deviceId: string;
  managed?: import('./managed-client.js').ManagedDestination;
  bookmark?: { planId: string; effectId: string; representation: RepresentationKey; url: string; scope: CaptureScope; source: CaptureSource };
}
export type PlannedNativeResult = { status: 'confirmed'; reusedFrom?: 'sourceArchive' | 'semantic'; native: NativeBinding; written?: { title: string; parentId: string; url?: string } } | { status: 'unknown' | 'blocked'; reason: string };
export interface SourceOutbox { command: PlannedNativeCommand; digest: string; state: 'reserved' | 'submitted' | 'unknown' | 'acknowledged'; native?: NativeBinding; executorAcknowledged?: boolean }
export interface PlannedExecutionPorts {
  deviceId(): Promise<string>; scope(): Promise<CaptureScope>;
  authorize(plan: SavePlan, effect: SaveEffect): Promise<void>;
  assertNative(binding: NativeBinding<'folder'>): Promise<void>;
  prepare?(command: PlannedNativeCommand, plan: SavePlan, effect: SaveEffect): Promise<PlannedNativeCommand>;
  execute(command: PlannedNativeCommand, digest: string, authorize: () => Promise<void>): Promise<PlannedNativeResult>;
  recover(command: PlannedNativeCommand, digest: string): Promise<PlannedNativeResult | null>;
  beforeSubmit?(command: PlannedNativeCommand): Promise<void>;
  beforeSourceCommit?(command: PlannedNativeCommand): Promise<void>;
  acknowledge(command: PlannedNativeCommand, digest: string): Promise<void>;
}
