export function evaluateSourceFileSizes(
  lineCounts: Readonly<Record<string, number>>,
  baseline: {
    readonly maximumNewFileLines: number;
    readonly grandfathered: Readonly<Record<string, number>>;
  },
): string[];

export function inspectProductionSourceFileSizes(): Promise<{
  readonly baseline: {
    readonly maximumNewFileLines: number;
    readonly grandfathered: Readonly<Record<string, number>>;
  };
  readonly fileCount: number;
  readonly errors: readonly string[];
}>;
