export function evaluateSourceFileSizes(
  lineCounts: Readonly<Record<string, number>>,
  baseline: {
    readonly maximumNewFileLines: number;
    readonly grandfathered: Readonly<Record<string, number>>;
    readonly excludeFileNames?: readonly string[];
  },
): string[];

export function inspectProductionSourceFileSizes(): Promise<{
  readonly baseline: {
    readonly maximumNewFileLines: number;
    readonly grandfathered: Readonly<Record<string, number>>;
    readonly excludeFileNames?: readonly string[];
  };
  readonly fileCount: number;
  readonly errors: readonly string[];
}>;
