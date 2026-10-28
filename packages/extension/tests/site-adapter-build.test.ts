import { expect, test } from 'vitest';
import { resolve } from 'node:path';
import { loadBundledSites, siteAdapterEntries } from '../scripts/site-adapter-entries.mjs';
const root = resolve(import.meta.dirname, '..');
test('the registered site definitions are the sole source of packaged page and probe entries', async () => {
  const sites = await loadBundledSites(root), result = await siteAdapterEntries(root, sites, ['service-worker', 'options']);
  expect(sites.map(s => s.adapterId)).toEqual(['bundled.bilibili']);
  expect(result.bundles).toEqual([{ adapterId: 'bundled.bilibili', adapter: 'site-adapter.js', probe: 'site-probe.js' }]);
  expect(Object.keys(result.entries).sort()).toEqual(['site-adapter', 'site-probe']);
  const site = sites[0]!;
  await expect(siteAdapterEntries(root, [{ ...site, build: undefined }])).rejects.toThrow('invalidSiteBuildEntry');
  await expect(siteAdapterEntries(root, [site, { ...site, adapterId: 'fixture.only' }])).rejects.toThrow('duplicateSiteBuildOutput');
  await expect(siteAdapterEntries(root, [site], ['site-adapter'])).rejects.toThrow('duplicateSiteBuildOutput');
  await expect(siteAdapterEntries(root, [{ ...site, scripts: { adapter: '../service-worker.js' } }])).rejects.toThrow('invalidSiteBuildEntry');
  await expect(siteAdapterEntries(root, [{ ...site, build: { adapter: '../../outside.ts' } }])).rejects.toThrow('invalidSiteBuildEntry');
});
