import type { BrowserRequestResult } from './device-bridge.js';

/** Includes the completion envelope; matches automation-device/bridge-results admission. */
export const DEVICE_RESULT_MAX_BYTES = 32_768;
export function deviceResultFits(response: BrowserRequestResult): boolean {
  try { return new TextEncoder().encode(JSON.stringify(response)).byteLength <= DEVICE_RESULT_MAX_BYTES; }
  catch { return false; }
}
export function failedDeviceResult(requestId: string, code: string): BrowserRequestResult {
  return { requestId, state: 'failed', result: { code } };
}
export function boundedDeviceResult(response: BrowserRequestResult): BrowserRequestResult {
  return deviceResultFits(response) ? response : failedDeviceResult(response.requestId, 'device_result_too_large');
}

/** Never omit an oversized task or advance past it. Return a cursor only after the last included task. */
export function deviceResultPage<T extends { id: string }>(requestId: string, candidates: readonly T[], base: Record<string, unknown>) {
  const items: T[] = [];
  let nextCursor: string | null = null;
  for (const item of candidates.slice(0, 20)) {
    const next = [...items, item], cursor = candidates.length > next.length ? item.id : null;
    if (!deviceResultFits({ requestId, state: 'done', result: { ...base, items: next, nextCursor: cursor } })) {
      if (!items.length) throw new Error('device_result_too_large');
      break;
    }
    items.push(item); nextCursor = cursor;
  }
  const result = { ...base, items, nextCursor };
  if (!deviceResultFits({ requestId, state: 'done', result })) throw new Error('device_result_too_large');
  return result;
}
