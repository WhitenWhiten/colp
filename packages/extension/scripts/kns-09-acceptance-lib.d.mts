export const REQUIRED_GATE_IDS: readonly string[];

export type AcceptanceGate = {
  readonly id: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly status?: string;
  readonly testedCommit?: string;
};

export function evaluateAcceptance(input: {
  readonly expectedCommit?: string;
  readonly testedCommit?: string;
  readonly gates?: readonly AcceptanceGate[];
  readonly dirtyInputPaths?: readonly string[];
  readonly requiredIds?: readonly string[];
}): {
  readonly verdict: 'accepted' | 'rejected';
  readonly reasons: readonly string[];
  readonly requiredIds: readonly string[];
};

export function inputDirtyPaths(porcelain: string): string[];

export const INDEXED_DB_NAME: 'known-phase3-indexeddb-entry';

export function indexedDbPin(schemaSource: string): { readonly name: string; readonly version: number };

export function rollbackPin(version: number): string;

export function requireSchemaVersion(
  schemaSource: string, expected: number,
): { readonly name: string; readonly version: number };
