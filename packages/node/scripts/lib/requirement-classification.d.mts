export function classifyRequirementOccurrence(occurrence: {
  readonly source: string;
  readonly section?: string;
  readonly quote: string;
}): readonly [string, string];
