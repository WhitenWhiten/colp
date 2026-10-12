import type { AccountScope, NativeOperation } from './local-types.js';

export function preservationKey(scope: Pick<AccountScope, 'serverOrigin' | 'accountId'>): string {
  return 'preservation:' + JSON.stringify([scope.serverOrigin, scope.accountId]);
}

export function isPreservationCreate(op: NativeOperation): boolean {
  if (op.kind !== 'create' || op.node) return false;
  if (op.purpose === 'preservation') return true;
  // Before explicit purposes, preservation was the only create without both a
  // projection node and a local key. Use that journal shape, never folder titles.
  return op.purpose === undefined && op.localKey === undefined
    && op.parentNativeId !== undefined && Array.isArray(op.beforeIds);
}
