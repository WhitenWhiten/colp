export type LegacyMcpAbsenceTier = 'identifier' | 'wire';
export type LegacyMcpAbsenceSymbol = Readonly<{
  readonly id: string;
  readonly tier: LegacyMcpAbsenceTier;
  readonly mcpScoped: boolean;
  readonly source: string;
}>;
export const legacyMcpAbsenceSymbols: readonly LegacyMcpAbsenceSymbol[];
export function isMcpScopedPath(path: string): boolean;
export function isDocumentedRejectionLine(line: string): boolean;
export function stripCodeComments(source: string): string;
export type LegacyMcpAbsenceFinding = Readonly<{
  readonly symbol: string;
  readonly index: number;
  readonly line: number;
}>;
export function scanTextForLegacyMcpSymbols(
  source: string,
  options?: {
    readonly path?: string;
    readonly stripComments?: boolean;
    readonly allowDocumentedRejection?: boolean;
  },
): LegacyMcpAbsenceFinding[];
export type LegacyMcpAbsenceFile = Readonly<{ readonly path: string; readonly content: string }>;
export function scanLegacyMcpAbsence(options: {
  readonly sourceFiles: readonly LegacyMcpAbsenceFile[];
  readonly declarationFiles: readonly LegacyMcpAbsenceFile[];
  readonly tarballFiles: readonly LegacyMcpAbsenceFile[];
}): Readonly<{
  readonly ok: boolean;
  readonly findings: readonly (LegacyMcpAbsenceFinding & { readonly path: string })[];
  readonly scanned: Readonly<{
    readonly sourceFiles: number;
    readonly declarationFiles: number;
    readonly tarballFiles: number;
  }>;
}>;
