import type { WorkPrincipal } from './claim-job.js';
export const DEVICE_BRIDGE_OPERATIONS = ['adapters.status','adapters.jobs','adapters.diagnostics','adapters.retry',
  'classification.diagnostics','classification.preview','classification.retry'] as const;
export type DeviceBridgeOperation = typeof DEVICE_BRIDGE_OPERATIONS[number];
export interface DeviceBridgeRequest { id: string; replicaId: string; collectionId: string; operation: DeviceBridgeOperation;
  input: { connectionId?: string; jobId?: string; cursor?: string; group?: 'recovery' | 'history' }; expiresAt: string }
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
