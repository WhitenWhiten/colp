/** Stable codes only: never persist exception prose, URLs or credentials. */
export function reasonCode(error: unknown, fallback: string): string {
  const structured = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
  for (const value of [structured, error instanceof Error ? error.message : undefined]) {
    if (typeof value === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/.test(value)) return value;
  }
  return fallback;
}
