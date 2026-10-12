import type { FirstRunOrScopeResponse, FirstRunRequest, ScopeCommandRequest } from '../types.js';

/** KNS-00 fail-closed stubs: names exist, no remote writes and no IndexedDB mutations. */
export function handleFirstRunStub(message: FirstRunRequest): FirstRunOrScopeResponse {
  void message;
  return { ok: false, error: 'not_implemented' };
}

export function handleScopeCommandStub(message: ScopeCommandRequest): FirstRunOrScopeResponse {
  void message;
  return { ok: false, error: 'not_implemented' };
}
