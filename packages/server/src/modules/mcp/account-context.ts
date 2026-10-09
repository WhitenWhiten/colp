/**
 * Host-only MCP account subject threading (T-A4).
 *
 * COLP bindings carry `principalId = accounts.id` after OAuth account
 * resolution. Product access-policy and actor `subjectId` fields must keep
 * `accounts.subject_id`. The host request `authorization` residual and a
 * request-scoped AsyncLocalStorage both carry that subject id without changing
 * COLP `createPhase4bMcpRequestContext`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY = 'accountSubjectId' as const;

const mcpGrantedScopesStorage = new AsyncLocalStorage<readonly string[]>();

export function runWithMcpGrantedScopes<T>(scopes: readonly string[], work: () => T): T {
  return mcpGrantedScopesStorage.run(Object.freeze([...scopes]), work);
}

export function readMcpGrantedScopes(): readonly string[] | undefined {
  return mcpGrantedScopesStorage.getStore();
}

const mcpAccountSubjectIdStorage = new AsyncLocalStorage<string>();

export function runWithMcpAccountSubjectId<T>(
  accountSubjectId: string,
  work: () => T,
): T {
  return mcpAccountSubjectIdStorage.run(accountSubjectId, work);
}

export function readMcpAccountSubjectId(
  authorization?: Readonly<Record<string, unknown>>,
): string | undefined {
  const fromAuthorization = authorization?.[MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY];
  if (typeof fromAuthorization === 'string' && fromAuthorization.trim() !== '') {
    return fromAuthorization;
  }
  const fromStore = mcpAccountSubjectIdStorage.getStore();
  if (typeof fromStore === 'string' && fromStore.trim() !== '') {
    return fromStore;
  }
  return undefined;
}

export function requireMcpAccountSubjectId(
  authorization?: Readonly<Record<string, unknown>>,
): string {
  const accountSubjectId = readMcpAccountSubjectId(authorization);
  if (accountSubjectId === undefined) {
    throw new TypeError(
      'MCP authenticated actor requires accountSubjectId from OAuth account resolution.',
    );
  }
  return accountSubjectId;
}
