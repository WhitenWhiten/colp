/** Preserve a stable local error code in the durable queue without storing prose. */
export function reasonCode(error: unknown, fallback: string) {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_:-]{0,63}$/.test(value) ? value : fallback;
}
