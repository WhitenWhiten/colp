import type { SiteDefinition } from './registry-types.js';
import { installationKey } from './installation.js';
export function bundledScriptDefinitions(definition: SiteDefinition): chrome.scripting.RegisteredContentScript[] {
  return [
    ...(definition.scripts.probe ? [{ id: installationKey('known-site-probe', definition), js: [definition.scripts.probe],
      matches: [...definition.matches], runAt: 'document_start' as const, world: 'MAIN' as const, allFrames: false, persistAcrossSessions: true }] : []),
    { id: installationKey('known-site-adapter', definition), js: [definition.scripts.adapter], matches: [...definition.matches],
      runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true },
  ];
}
export function sameScriptRegistration(actual: chrome.scripting.RegisteredContentScript, desired: chrome.scripting.RegisteredContentScript): boolean {
  return actual.id === desired.id && JSON.stringify(actual.js) === JSON.stringify(desired.js)
    && JSON.stringify([...actual.matches].sort()) === JSON.stringify([...desired.matches].sort()) && actual.world === desired.world
    && actual.runAt === desired.runAt && (actual.allFrames ?? false) === desired.allFrames && (actual.persistAcrossSessions ?? true) === desired.persistAcrossSessions;
}
export async function reconcileBundledScripts(definition: SiteDefinition, enabled: boolean) {
  const ids = [installationKey('known-site-probe', definition), installationKey('known-site-adapter', definition)];
  if (!enabled) { await chrome.scripting?.unregisterContentScripts({ ids }).catch(() => undefined); return; }
  const desired = bundledScriptDefinitions(definition), existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  const obsolete = existing.filter(old => !desired.some(next => sameScriptRegistration(old, next)));
  if (obsolete.length) await chrome.scripting.unregisterContentScripts({ ids: obsolete.map(s => s.id) });
  const missing = desired.filter(next => !existing.some(old => sameScriptRegistration(old, next)));
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
}
