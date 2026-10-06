export interface NormativeOccurrence {
  readonly source: string;
  readonly section?: string;
  readonly line: number;
  readonly quote: string;
  readonly quoteOrdinal: number;
  readonly keywordOrdinal: number;
  readonly level: 'MUST' | 'MUST_NOT' | 'SHOULD' | 'SHOULD_NOT' | 'MAY';
}

export function scanMarkdownSource(
  source: string,
  sourcePath: string,
): readonly NormativeOccurrence[];
export function stableSectionAnchor(section: string): string;
