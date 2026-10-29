import { build } from 'esbuild';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** Build metadata comes from the same audited registry as the worker and settings. No page code is evaluated. */
export async function loadBundledSites(root) {
  const result = await build({ entryPoints: [resolve(root, 'src/site-adapters/registry.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)).bundledSites;
}
/** Every installed package runs on this one host-built page runtime (src/site-adapters/community-definition.ts COMMUNITY_RUNTIME_SCRIPT). */
export const COMMUNITY_RUNTIME = Object.freeze({ key: 'site-adapter-community', input: 'site-adapters/community-page.ts' });
export async function siteAdapterEntries(root, sites, reserved = []) {
  const source = await realpath(resolve(root, 'src')), entries = {}, occupied = new Set([...reserved, COMMUNITY_RUNTIME.key]), bundles = [];
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
  entries[COMMUNITY_RUNTIME.key] = await realpath(resolve(source, COMMUNITY_RUNTIME.input));
  bundles.push({ runtime: 'userScript', adapter: `${COMMUNITY_RUNTIME.key}.js` });
  return { entries, bundles };
}
