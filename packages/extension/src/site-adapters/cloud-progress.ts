/** Membership ordinals, rather than a sorted item cursor, keep later lower-ID additions visible. */
export function cloudEdgeUnseen(processed: Readonly<Record<string, number>> | undefined, key: string, ordinal: number) {
  return !processed || !Object.hasOwn(processed, key) || processed[key]! < ordinal;
}
export function cloudProgress(processed: Readonly<Record<string, number>> | undefined, accepted: Readonly<Record<string, number>>) {
  const next = { ...processed };
  for (const [key, ordinal] of Object.entries(accepted)) next[key] = Math.max(next[key] ?? 0, ordinal);
  if (Object.keys(next).length > 50000) throw new Error('sourceCloudCapacity');
  return next;
}
