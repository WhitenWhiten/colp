import { inspectCommunityPackage, installedSite, installedSites, COMMUNITY_RISK, type PackagePreview } from './community-package.js';
import { communityStore, communityScriptId, communityWorldId, fenceCommunity, type CommunityInstallation } from './community-state.js';
import { communityApiAvailable } from './community-authority.js';
import { communityRegistration, communityRegistrationMatches, communityScripts } from './community-registration.js';
import { object, literal, str, jsonBytes } from './schema.js';
import { createLane } from '../automation/lane.js';
const PREVIEW = 'known.siteAdapters.communityPreview.v1';
const statusSchema = object({ kind: literal('known.community.status') });
const previewSchema = object({ kind: literal('known.community.preview'), text: str(512 * 1024) });
const installSchema = object({ kind: literal('known.community.install'), digest: str(128), acknowledgeRisk: literal(true) });
const removeSchema = object({ kind: literal('known.community.remove'), installationId: str(128) });
const rollbackSchema = object({ kind: literal('known.community.rollback'), installationId: str(128), digest: str(128), acknowledgeRisk: literal(true) });
const reviewSchema = object({ kind: literal('known.community.reviewVersion'), installationId: str(128), digest: str(128) });
export const validCommunityManagement = (v: unknown) => jsonBytes(v, 600 * 1024) && [statusSchema, previewSchema, installSchema, removeSchema, rollbackSchema, reviewSchema].some(s => s(v));
/** The package's own world: its reviewed script, messaging to the host, and fetches limited to its site and declared origins. */
export const communityWorld = {
  async register(row: CommunityInstallation) {
    const manifest = row.approved.package.manifest, origins = [...new Set([...manifest.matches.map(m => new URL(m).origin), ...manifest.connectOrigins ?? []])];
    await chrome.userScripts.configureWorld({ worldId: communityWorldId(row), messaging: true, csp: `script-src 'self'; object-src 'none'; connect-src 'self' ${origins.join(' ')}` });
    const found = await chrome.userScripts.getScripts({ ids: [communityScriptId(row)] });
    if (communityRegistrationMatches(row, found)) return;
    if (found.length) await chrome.userScripts.unregister({ ids: [communityScriptId(row)] });
    await chrome.userScripts.register([communityRegistration(row)]);
  },
  async unregister(row: CommunityInstallation) {
    await chrome.userScripts?.unregister({ ids: [communityScriptId(row)] }).catch(() => undefined);
    await chrome.userScripts?.configureWorld({ worldId: communityWorldId(row), messaging: false }).catch(() => undefined);
    await chrome.userScripts?.resetWorldConfiguration(communityWorldId(row)).catch(() => undefined);
  },
  /** Attach to exactly the document whose URL was checked: by injection time the tab may hold another origin's page.
      Chrome 135+ executes immediately in the named world; there is no scripting/MAIN fallback. */
  inject: (row: CommunityInstallation, tabId: number, documentId: string) => bounded(chrome.userScripts.execute({ target: { tabId, documentIds: [documentId] }, world: 'USER_SCRIPT',
    worldId: communityWorldId(row), js: communityScripts(row), injectImmediately: true }), 8000),
  stop: (row: CommunityInstallation, tabId: number) => bounded(chrome.userScripts.execute({ target: { tabId }, world: 'USER_SCRIPT', worldId: communityWorldId(row), injectImmediately: true,
    js: [{ code: `dispatchEvent(new Event(${JSON.stringify(`known-site-adapter-stop:${row.approved.package.manifest.adapterId}`)}));` }] }), 2000),
};
/** A hung or frozen page must not hold up the host: these calls depend on the renderer. */
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('communityPageUnavailable')), ms); })]).finally(() => clearTimeout(timer));
}
interface Ports { ready(): Promise<void>; changed(): Promise<void> }
export function createCommunityRuntime(ports: Ports) {
  const lane = createLane();
  /** An extension update gives every package a new credential and world; Chrome also clears registrations on update. */
  async function prepare() {
    const version = chrome.runtime.getManifest().version;
    if ((await communityStore.read()).some(r => r.hostVersion !== version))
      await communityStore.mutate(rows => { for (const r of rows) if (r.hostVersion !== version) { fenceCommunity(r); r.hostVersion = version; } });
    return communityStore.read();
  }
  /** Registrations and worlds of removed packages or replaced generations. */
  async function prune(rows: readonly CommunityInstallation[]) {
    const scripts = await communityApiAvailable(), ids = new Set(rows.map(communityScriptId)), worlds = new Set(rows.map(communityWorldId));
    const stale = scripts.filter(s => s.id.startsWith('colp-user-') && !ids.has(s.id)).map(s => s.id);
    if (stale.length) await chrome.userScripts.unregister({ ids: stale });
    for (const world of await chrome.userScripts.getWorldConfigurations()) if (world.worldId?.startsWith('colp-user-') && !worlds.has(world.worldId)) {
      await chrome.userScripts.configureWorld({ worldId: world.worldId, messaging: false }); await chrome.userScripts.resetWorldConfiguration(world.worldId);
    }
  }
  async function claimedSite(preview: PackagePreview) {
    const others = (await communityStore.read()).filter(r => r.approved.package.manifest.adapterId !== preview.package.manifest.adapterId);
    const { siteKey, identityVersion } = preview.package.manifest;
    if (others.some(r => r.approved.package.manifest.siteKey === siteKey && r.approved.package.manifest.identityVersion === identityVersion)) throw new Error('communitySiteKeyTaken');
  }
  async function management(raw: unknown) {
    if (!validCommunityManagement(raw)) throw new Error('invalid'); await ports.ready();
    const input = raw as { kind: string; text: string; digest: string; installationId: string };
    if (previewSchema(raw)) {
      const preview = inspectCommunityPackage(input.text); await claimedSite(preview);
      const old = (await communityStore.read()).find(r => r.approved.package.manifest.adapterId === preview.package.manifest.adapterId);
      await chrome.storage.session.set({ [PREVIEW]: { ...preview, expiresAt: Date.now() + 600000 } });
      return { ok: true, preview: { digest: preview.digest, bytes: preview.bytes, ...preview.package, previous: old ? { digest: old.approved.digest, manifest: old.approved.package.manifest, provenance: old.approved.package.provenance } : null, risk: COMMUNITY_RISK, publisherTrust: 'unverified' } };
    }
    if (reviewSchema(raw)) {
      const row = (await communityStore.read()).find(r => r.id === input.installationId), previous = row?.previous.find(p => p.digest === input.digest);
      if (!row || !previous) throw new Error('communityRollbackUnavailable');
      await claimedSite(previous);
      await chrome.storage.session.set({ [PREVIEW]: { rollback: true, installationId: row.id, generation: row.generation, digest: previous.digest, expiresAt: Date.now() + 600000 } });
      return { ok: true, preview: { digest: previous.digest, ...previous.package, risk: COMMUNITY_RISK, publisherTrust: 'unverified', rollback: true } };
    }
    if (installSchema(raw)) {
      const preview = (await chrome.storage.session.get(PREVIEW))[PREVIEW] as PackagePreview & { expiresAt: number } | undefined;
      if (!preview || preview.expiresAt <= Date.now() || preview.digest !== input.digest || inspectCommunityPackage(preview.text).digest !== input.digest) throw new Error('communityPreviewExpired');
      await claimedSite(preview);
      await communityStore.mutate(rows => {
        const r = rows.find(r => r.approved.package.manifest.adapterId === preview.package.manifest.adapterId);
        if (r) {
          if (r.approved.digest === preview.digest) return;
          if (r.approved.package.manifest.version === preview.package.manifest.version) throw new Error('communityVersionConflict');
          fenceCommunity(r); r.hostVersion = chrome.runtime.getManifest().version; r.previous = [r.approved, ...r.previous].slice(0, 3); r.approved = preview; r.error = null;
        } else {
          if (rows.length >= 8) throw new Error('communityCapacity');
          rows.push({ id: crypto.randomUUID(), generation: 1, credential: crypto.randomUUID() + crypto.randomUUID(), hostVersion: chrome.runtime.getManifest().version,
            approved: preview, previous: [], error: null });
        }
      });
      await chrome.storage.session.remove(PREVIEW); await ports.changed();
    } else if (removeSchema(raw)) {
      await communityStore.mutate(rows => { const index = rows.findIndex(r => r.id === input.installationId); if (index >= 0) rows.splice(index, 1); });
      await ports.changed();
    } else if (rollbackSchema(raw)) {
      const old = (await communityStore.read()).find(r => r.id === input.installationId);
      const preview = (await chrome.storage.session.get(PREVIEW))[PREVIEW] as { rollback?: boolean; installationId: string; generation: number; digest: string; expiresAt: number } | undefined;
      if (!old || !preview?.rollback || preview.installationId !== old.id || preview.generation !== old.generation || preview.digest !== input.digest || preview.expiresAt <= Date.now()) throw new Error('communityPreviewExpired');
      await communityStore.mutate(rows => { const r = rows.find(r => r.id === input.installationId), previous = r?.previous.find(p => p.digest === input.digest);
        if (!r || !previous || inspectCommunityPackage(previous.text).digest !== previous.digest) throw new Error('communityRollbackUnavailable');
        const { siteKey, identityVersion } = previous.package.manifest;
        if (rows.some(o => o.id !== r.id && o.approved.package.manifest.siteKey === siteKey && o.approved.package.manifest.identityVersion === identityVersion)) throw new Error('communitySiteKeyTaken');
        fenceCommunity(r); r.hostVersion = chrome.runtime.getManifest().version; r.previous = [r.approved, ...r.previous.filter(p => p.digest !== previous.digest)].slice(0, 3); r.approved = previous; r.error = null;
      });
      await chrome.storage.session.remove(PREVIEW); await ports.changed();
    }
    let available = true, unavailable: string | null = null;
    try { await communityApiAvailable(); } catch (e) { available = false; unavailable = e instanceof Error ? e.message : 'communityUnavailable'; }
    const rows = await communityStore.read(), runnable = new Set(installedSites(rows).map(s => s.row.id));
    return { ok: true, available, unavailable, browserToggle: 'Chrome 149+: Extensions → Details → Allow User Scripts', supportedMinimum: 149,
      installations: rows.map(r => ({ id: r.id, generation: r.generation, digest: r.approved.digest, manifest: r.approved.package.manifest, provenance: r.approved.package.provenance,
        previous: r.previous.map(p => ({ digest: p.digest, version: p.package.manifest.version })),
        error: runnable.has(r.id) ? r.error : installedSite(r) ? 'communitySiteKeyTaken' : 'communityPackageOutdated' })) };
  }
  return { management: (raw: unknown) => lane(() => management(raw)), prepare, prune };
}
