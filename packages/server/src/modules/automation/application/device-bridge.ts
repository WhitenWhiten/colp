import type { WorkPrincipal } from './claim-job.js';
export const DEVICE_BRIDGE_OPERATIONS = ['adapters.status','adapters.jobs','adapters.diagnostics','adapters.retry',
  'classification.diagnostics','classification.preview','classification.retry',
  'classification.captures.list','classification.captures.get','classification.captures.retry',
  'adapters.tasks.list','adapters.tasks.get','adapters.tasks.control',
  'browser_rules.list','browser_rules.folders','browser_rules.configure','browser_rules.preview',
  'browser_rules.run_preview','browser_rules.run_apply','browser_rules.run_undo','browser_rules.runs'] as const;
export type DeviceBridgeOperation = typeof DEVICE_BRIDGE_OPERATIONS[number];
export interface DeviceBridgeRequest { id: string; replicaId: string; collectionId: string; operation: DeviceBridgeOperation;
  input: { connectionId?: string; jobId?: string; cursor?: string; group?: 'recovery' | 'history'; captureId?: string; baseRevision?: number;
    request?: Record<string, unknown>; parentNativeId?: string; scopeNativeId?: string; previewId?: string; runId?: string;
    bookmark?: { title: string; url: string }; tags?: boolean; taskId?: string; revision?: string;
    taskKind?: 'semantic' | 'confirmation' | 'import' | 'save' | 'transfer' | 'reconcile' | 'observation'; action?: 'retry' | 'resume' | 'cancel' }; expiresAt: string }
export interface DeviceBridgeView { requestId: string; replicaId: string; operation: DeviceBridgeOperation;
  state: 'pending' | 'running' | 'done' | 'failed' | 'expired'; expiresAt: string; result: unknown }
export interface DeviceBridgeOwnerPort {
  request(actor: WorkPrincipal, operation: DeviceBridgeOperation, args: Readonly<Record<string, unknown>>): Promise<DeviceBridgeView>;
  get(actor: WorkPrincipal, id: string): Promise<DeviceBridgeView>;
}
export interface DeviceBridgeDevicePort {
  pending(): Promise<{ items: DeviceBridgeRequest[] }>;
  complete(body: unknown): Promise<{ recorded: boolean }>;
}
