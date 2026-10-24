import { bundledSites, legacySite, siteDefinition } from './registry.js';
export const selectedSite = siteDefinition(new URL(location.href).searchParams.get('adapterId') ?? legacySite.adapterId);
export const sendSiteMessage = (message: unknown) => chrome.runtime.sendMessage({ ...(message as Record<string, unknown>), adapterId: selectedSite.adapterId });
export function mountSiteSelector() {
  const label = document.createElement('label'), select = document.createElement('select');
  label.textContent = 'Site adapter '; select.id = 'adapter-select';
  for (const site of bundledSites) select.append(new Option(site.label, site.adapterId));
  select.value = selectedSite.adapterId;
  select.onchange = () => { const url = new URL(location.href); url.searchParams.set('adapterId', select.value); location.assign(url.href); };
  label.append(select); document.querySelector('main')?.prepend(label);
}
