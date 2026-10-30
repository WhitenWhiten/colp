import type { AutomationStateArea } from './bundle-store.js';
import { boundedDeviceResult, failedDeviceResult } from './device-bridge-result.js';
export const DEVICE_BRIDGE_KEY = 'known.automation.device-bridge.v1';
export const DEVICE_BRIDGE_STATUS_KEY = 'known.automation.device-bridge-status.v1';
export interface BrowserRequest { id: string; replicaId: string; collectionId: string; operation: string;
  input: { jobId?: string; connectionId?: string; cursor?: string; group?: 'recovery' | 'history'; captureId?: string;
    baseRevision?: number; request?: Record<string, unknown>; adapterId?: string; parentNativeId?: string; scopeNativeId?: string; previewId?: string; runId?: string; bookmark?: { title: string; url: string }; tags?: boolean;
    taskKind?: import('../site-adapters/agent-tasks.js').AdapterTaskKind; taskId?: string; revision?: string;
    action?: import('../site-adapters/agent-tasks.js').AdapterTaskAction }; expiresAt: string }
export interface BrowserRequestResult { requestId: string; state: 'done' | 'failed'; result: unknown }
export const isCaptureBridgeOperation = (request: BrowserRequest) => request.operation.startsWith('classification.captures.')
  || request.operation === 'classification.preview' && !request.input.jobId;
export type DeviceCompletion = 'accepted' | 'retry' | 'tooLarge' | 'rejected';
/** A write-ahead dispatch marker prevents replay after a worker dies during a paid preview or retry. */
export function createDeviceBridgeRunner(area: AutomationStateArea, ports: {
  authorize(request: BrowserRequest): Promise<void>; execute(request: BrowserRequest): Promise<unknown>;
  complete(result: BrowserRequestResult): Promise<DeviceCompletion>;
}) {
  async function complete(key: string, result: BrowserRequestResult) {
    // Also migrate cached results from older workers before retrying their upload.
    let response = boundedDeviceResult(result);
    await area.set(key, response);
    let outcome: DeviceCompletion;
    try { outcome = await ports.complete(response); } catch { return; }
    if (outcome === 'tooLarge' || outcome === 'rejected') {
      response = failedDeviceResult(response.requestId, outcome === 'tooLarge' ? 'device_result_too_large' : 'device_result_rejected');
      await area.set(key, response);
      await ports.complete(response).catch(() => 'retry');
    }
  }
  return async (requests: readonly BrowserRequest[]) => {
    for (const request of requests) {
      const key = `${DEVICE_BRIDGE_KEY}.request.${request.id}`;
      const old = await area.get(key) as { state: 'started' } | BrowserRequestResult | undefined;
      let response: BrowserRequestResult;
      try {
        await ports.authorize(request);
        if (old && old.state !== 'started') { response = old; }
        else {
          if (old) throw new Error('device_result_unknown');
          if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('device_request_expired');
          await area.set(key, { state: 'started' });
          await ports.authorize(request);
          const result = await ports.execute(request);
          await ports.authorize(request);
          response = { requestId: request.id, state: 'done', result };
        }
      } catch (error) {
        // Stable host codes only; provider messages and credentials never leave the browser.
        const code = error instanceof Error && /^[a-zA-Z0-9_]{1,80}$/u.test(error.message) ? error.message : 'device_operation_failed';
        response = { requestId: request.id, state: 'failed', result: { code } };
      }
      await complete(key, response);
    }
  };
}
