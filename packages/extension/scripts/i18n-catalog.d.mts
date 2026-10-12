export const TRANSLATIONS: readonly string[];
export function extract(): { messages: Map<string, { message: string; sites: string[] }>; errors: string[] };
export function englishCatalog(extracted: ReturnType<typeof extract>): Record<string, { message: string; description?: string }>;
export function translationGaps(english: Record<string, { message: string }>, locale: string): { gaps: Record<string, unknown>; errors: string[] };
export function check(): string[];
