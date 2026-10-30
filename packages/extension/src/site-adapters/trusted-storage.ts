/** Privileged storage remains inaccessible to installed page scripts. Failed
 * setup is retried on the next request rather than cached for this worker. */
export function createTrustedSiteStorage(areas: readonly {
  setAccessLevel?(details: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}[]) {
  let ready: Promise<void> | undefined;
  return () => ready ??= (async () => {
    for (const area of areas) {
      if (!area.setAccessLevel) throw Error('storageBoundaryUnavailable');
      await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
  })().catch(error => { ready = undefined; throw error; });
}
