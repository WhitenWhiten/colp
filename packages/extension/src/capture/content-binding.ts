import type { CaptureTask } from './contracts.js';
export interface CaptureContentIntent {
  bindingId: string; itemId: string; connectionId: string | null; mode: 'create' | 'reuse' | 'reclassify' | 'suggest';
  captureIntentId: string; forceAnother?: boolean; nativeId?: string; dateAdded?: number; title: string; url: string; parentId: string;
  managed?: import('../site-adapters/managed-client.js').ManagedDestination;
  managedParent?: import('../site-adapters/contracts.js').NativeBinding<'folder'>;
}
interface Hooks {
  prepare(input: { captureIntentId: string; commandId: string; source: CaptureTask['source']; tabId?: number; url: string; title: string; parentId: string; automatic: boolean }): Promise<CaptureContentIntent | null>;
  assert(task: CaptureTask): Promise<void>;
  acknowledge(task: CaptureTask): Promise<void>;
  move?(task: CaptureTask, target: string, move: () => Promise<unknown>): Promise<void>;
}
let hooks: Hooks = { prepare: async () => null, assert: async () => {}, acknowledge: async () => {} };
export function installCaptureContentBindings(value: Hooks) { hooks = value; }
export const prepareCaptureContent = (input: Parameters<Hooks['prepare']>[0]) => hooks.prepare(input);
export const assertCaptureContent = (task: CaptureTask) => hooks.assert(task);
export const acknowledgeCaptureContent = (task: CaptureTask) => hooks.acknowledge(task);
export const moveCaptureContent = (task: CaptureTask, target: string, move: () => Promise<unknown>) => hooks.move ? hooks.move(task, target, move) : move().then(() => undefined);
