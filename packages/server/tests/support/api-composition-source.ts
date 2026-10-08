import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Production bootstrap files extracted from `api.ts` plus the process entry. */
export const API_COMPOSITION_RELATIVE_FILES = [
  'src/bootstrap/api.ts',
  'src/bootstrap/api-account-services.ts',
  'src/bootstrap/api-auth-mailbox.ts',
  'src/bootstrap/api-email-composition.ts',
  'src/bootstrap/api-lifecycle.ts',
  'src/bootstrap/api-mcp-oauth-composition.ts',
  'src/bootstrap/api-mcp-surface-composition.ts',
  'src/bootstrap/api-postgres-ports.ts',
  'src/bootstrap/api-rate-limit-composition.ts',
] as const;

export function readApiCompositionSource(backendRoot: string): string {
  return API_COMPOSITION_RELATIVE_FILES
    .map((relative) => readFileSync(resolve(backendRoot, relative), 'utf8'))
    .join('\n');
}
