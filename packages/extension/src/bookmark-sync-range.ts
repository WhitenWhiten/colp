/** Native membership includes the node itself and every known ancestor. */
export function folderIsInMount(nativeId: string, ancestorIds: readonly string[],
  mountNativeIds: ReadonlySet<string>): boolean {
  return mountNativeIds.has(nativeId) || ancestorIds.some(id => mountNativeIds.has(id));
}

export function folderSyncCoverage(nativeId: string, ancestorIds: readonly string[],
  selectedNative: ReadonlySet<string>, privateNative: ReadonlySet<string>) {
  return { selected: folderIsInMount(nativeId, ancestorIds, selectedNative),
    privateLocal: folderIsInMount(nativeId, ancestorIds, privateNative) };
}

/** Exclusions dominate selection, including a mount that lies below an excluded ancestor. */
export function folderIsInSyncRange(nativeId: string, ancestorIds: readonly string[],
  selectedNative: ReadonlySet<string>, privateNative: ReadonlySet<string>): boolean {
  const coverage = folderSyncCoverage(nativeId, ancestorIds, selectedNative, privateNative);
  return coverage.selected && !coverage.privateLocal;
}
