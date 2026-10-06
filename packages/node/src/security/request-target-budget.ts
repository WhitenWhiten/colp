import { TextByteBudget } from '../shared/text-budget.js';

export const MAX_SECURITY_REQUEST_TARGET_BYTES = 16 * 1024;
export const MAX_SECURITY_QUERY_ENTRIES = 256;

export class RequestTargetBudgetError extends RangeError {
  constructor() {
    super('Request target exceeds the security input budget.');
    this.name = 'RequestTargetBudgetError';
  }
}

/** Must run BEFORE decoding, URL construction, or URLSearchParams allocation. */
export function assertRequestTargetBudget(target: string): void {
  if (typeof target !== 'string') throw new TypeError('Request target must be a string.');
  try {
    new TextByteBudget(MAX_SECURITY_REQUEST_TARGET_BYTES, 'Request target').raw(target);
  } catch {
    throw new RequestTargetBudgetError();
  }
  const start = target.indexOf('?');
  if (start < 0) return;
  const fragment = target.indexOf('#');
  if (fragment >= 0 && fragment < start) return;
  const end = fragment < 0 ? target.length : fragment;
  let count = 0;
  let nonempty = false;
  for (let index = start + 1; index <= end; index += 1) {
    if (index === end || target[index] === '&') {
      // URLSearchParams ignores empty segments (including trailing '&').
      if (nonempty && ++count > MAX_SECURITY_QUERY_ENTRIES) {
        throw new RequestTargetBudgetError();
      }
      nonempty = false;
    } else {
      nonempty = true;
    }
  }
}
