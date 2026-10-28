import { build } from 'esbuild';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** Build metadata comes from the same audited registry as the worker and settings. No page code is evaluated. */
export async function loadBundledSites(root) {
  const result = await build({ entryPoints: [resolve(root, 'src/site-adapters/registry.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)).bundledSites;
}
export async function siteAdapterEntries(root, sites, reserved = []) {
  const source = await realpath(resolve(root, 'src')), entries = {}, occupied = new Set(reserved), bundles = [];
  for (const site of sites) {
    const bundle = { adapterId: site.adapterId };
    for (const role of ['adapter', 'probe']) {
      const output = site.scripts[role], input = site.build?.[role];
      if (role === 'probe' && output === undefined && input === undefined) continue;
      if (typeof output !== 'string' || !/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/u.test(output)
        || typeof input !== 'string' || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts$/u.test(input)) throw Error(`invalidSiteBuildEntry:${site.adapterId}:${role}`);
      const key = output.slice(0, -3);
      if (occupied.has(key)) throw Error(`duplicateSiteBuildOutput:${output}`);
      occupied.add(key);
      const file = await realpath(resolve(source, input));
      if (!file.startsWith(source + sep)) throw Error(`invalidSiteBuildPath:${site.adapterId}`);
      entries[key] = file; bundle[role] = output;
    }
    bundles.push(bundle);
  }
  return { entries, bundles };
}
