import { inspectCommunityPackage, COMMUNITY_RISK, type PackagePreview } from './community-package.js';
import { communityWrapper } from './community-wrapper.js';
import { communityStore, communityScriptId, communityWorldId, communityScopeDigest, fenceCommunity, type CommunityInstallation, type CommunityArchiveScope } from './community-state.js';
import { COMMUNITY_GRANTS, communityApiAvailable, assertCommunityArchive } from './community-authority.js';
import { object, literal, str, integer, jsonBytes } from './schema.js';
import { validMembershipHint } from './schemas.js';
import { aidFromItem, decimal, BILIBILI } from './bilibili/identity.js';
import { validSiteSender, type SiteSender } from './transport.js';
import type { MembershipHint } from './contracts.js';
import type { SourceContext } from './ledger-types.js';
import { siteLedger } from './source-runtime.js';
import type { SourcePolicyRecord } from './layout.js';
import { sourceDigest, sourceKey } from './source-db.js';
import type { SourceAuthority } from './ledger-types.js';
import { createLane } from '../automation/lane.js';
import { communityRegistration, communityRegistrationMatches } from './community-registration.js';
const PREVIEW = 'known.siteAdapters.communityPreview.v1';
const statusSchema = object({ kind: literal('known.community.status') });
const previewSchema = object({ kind: literal('known.community.preview'), text: str(512 * 1024) });
const installSchema = object({ kind: literal('known.community.install'), digest: str(128), acknowledgeRisk: literal(true) });
const toggleSchema = object({ kind: literal('known.community.enable'), installationId: str(128), enabled: literal(true, false) });
const idSchema = object({ kind: literal('known.community.remove', 'known.community.scopePreview'), installationId: str(128) });
const scopeSchema = object({ kind: literal('known.community.scopeApprove'), installationId: str(128), digest: str(128) });
const rollbackSchema = object({ kind: literal('known.community.rollback'), installationId: str(128), digest: str(128), acknowledgeRisk: literal(true) });
const reviewSchema = object({ kind: literal('known.community.reviewVersion'), installationId: str(128), digest: str(128) });
export const validCommunityManagement = (v: unknown) => jsonBytes(v, 600 * 1024) && [statusSchema, previewSchema, installSchema, toggleSchema, idSchema, scopeSchema, rollbackSchema, reviewSchema].some(s => s(v));
const bootstrapSchema = object({ kind: literal('known.community.bootstrap'), installationId: str(128), generation: integer, credential: str(256) });
const hintSchema = object({ kind: literal('known.community.hint'), installationId: str(128), generation: integer, leaseId: str(128), capability: str(256), requestId: str(128), hint: validMembershipHint });
const scriptCode = (r: CommunityInstallation) => communityWrapper({ id: r.id, generation: r.generation, credential: r.credential, script: r.approved.package.script });
interface Ports {
  ready(): Promise<void>;
  source(tabId?: number): Promise<{ context: SourceContext; expiresAt: number } | null>;
  enqueue(context: SourceContext, requestId: string, hint: MembershipHint): Promise<unknown>;
  wake(): void;
}
export function createCommunityRuntime(ports: Ports) {
  const lane = createLane();
  async function bounded<T>(work: Promise<T>, ms = 8000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('communityPageUnavailable')), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function cleanup(r: CommunityInstallation) {
    for (const tab of await chrome.tabs.query({ url: [...r.approved.package.manifest.matches] }).catch(() => [])) {
      if (tab.id === undefined || tab.incognito) continue;
      const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null);
      if (frame?.documentLifecycle === 'active' && new URL(frame.url).origin === BILIBILI.origin && chrome.userScripts?.execute) await bounded(chrome.userScripts.execute({
        target: { tabId: tab.id, documentIds: [frame.documentId] }, world: 'USER_SCRIPT', worldId: communityWorldId(r), js: [{ code: 'globalThis.__colpCommunity?.stop();' }], injectImmediately: true,
      }), 2000).catch(() => undefined);
    }
    await chrome.userScripts?.unregister({ ids: [communityScriptId(r)] }).catch(() => undefined);
    await chrome.userScripts?.configureWorld({ worldId: communityWorldId(r), messaging: false }).catch(() => undefined);
    await chrome.userScripts?.resetWorldConfiguration(communityWorldId(r)).catch(() => undefined);
  }
  async function inject(r: CommunityInstallation, tabId?: number) {
    for (const tab of await chrome.tabs.query({ url: [...r.approved.package.manifest.matches] })) {
      if (tab.id === undefined || tab.incognito || tabId !== undefined && tab.id !== tabId) continue;
      const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null);
      if (!frame || frame.documentLifecycle !== 'active' || new URL(frame.url).origin !== BILIBILI.origin) continue;
      if (typeof chrome.userScripts.execute !== 'function') { await communityStore.mutate(rows => { const row = rows.find(x => x.id === r.id); if (row) row.error = 'reloadRequired'; }); continue; }
      await bounded(chrome.userScripts.execute({ target: { tabId: tab.id, documentIds: [frame.documentId] }, world: 'USER_SCRIPT', worldId: communityWorldId(r),
        js: [{ code: scriptCode(r) }], injectImmediately: true })).catch(() => communityStore.mutate(rows => {
          const row = rows.find(row => row.id === r.id); if (row?.generation === r.generation) row.error = 'communityPageUnavailable';
        }));
    }
  }
  async function register(r: CommunityInstallation, immediate = true) {
    if (inspectCommunityPackage(r.approved.text).digest !== r.approved.digest) throw new Error('communityPackageChanged');
    await chrome.userScripts.configureWorld({ worldId: communityWorldId(r), messaging: true,
      csp: "script-src 'self'; object-src 'none'; connect-src 'self' https://api.bilibili.com" });
    await chrome.userScripts.register([communityRegistration(r)]);
    if (immediate) await inject(r);
  }
  async function reconcile(update = false) {
    await ports.ready(); let scripts = await communityApiAvailable();
    let rows = await communityStore.read();
    const hostVersion = chrome.runtime.getManifest().version;
    if (update || rows.some(r => r.hostVersion !== hostVersion)) {
      const old = structuredClone(rows);
      rows = await communityStore.mutate(records => { for (const r of records) if (update || r.hostVersion !== hostVersion) { fenceCommunity(r, r.enabled); r.hostVersion = hostVersion; } return records; });
      for (const r of old) await cleanup(r);
      scripts = await chrome.userScripts.getScripts();
    }
    for (const s of scripts) {
      if (!s.id.startsWith('colp-user-')) continue;
      const r = rows.find(r => communityScriptId(r) === s.id && r.enabled);
      if (!r || s.worldId !== communityWorldId(r)) await chrome.userScripts.unregister({ ids: [s.id] });
    }
    const actual = await chrome.userScripts.getScripts();
    for (const r of rows.filter(r => r.enabled)) {
      const found = actual.find(s => s.id === communityScriptId(r));
      if (found) {
        if (!communityRegistrationMatches(r, actual)) {
          await communityStore.mutate(records => { const record = records.find(x => x.id === r.id); if (record) { fenceCommunity(record); record.error = 'communityRegistrationChanged'; } });
          await cleanup(r); continue;
        }
      }
      if (!found) await register(r);
    }
    const desired = new Set((await communityStore.read()).filter(r => r.enabled).map(communityWorldId));
    for (const world of await chrome.userScripts.getWorldConfigurations()) if (world.worldId?.startsWith('colp-user-') && !desired.has(world.worldId)) {
      await chrome.userScripts.configureWorld({ worldId: world.worldId, messaging: false }); await chrome.userScripts.resetWorldConfiguration(world.worldId);
    }
  }
  async function scopePreview(id: string) {
    await communityApiAvailable();
    const r = (await communityStore.read()).find(r => r.id === id), source = await ports.source();
    if (!r?.enabled || r.hostVersion !== chrome.runtime.getManifest().version || !source) throw new Error('communityConnectedSourceRequired');
    const c = source.context, config = await siteLedger.db.read<{ root: { nativeId: string }; collectionIds: string[]; live: boolean; state: string }>('meta', `archiveConfig:${c.connectionId}`);
    const policy = await siteLedger.db.read<SourcePolicyRecord>('meta', `policy:${c.connectionId}`);
    if (!config?.live || config.state !== 'active' || !policy?.enabled || !policy.liveArchive || !await chrome.permissions.contains({ permissions: ['bookmarks'] })) throw new Error('communityArchiveSetupRequired');
    const scope: CommunityArchiveScope = { connectionId: c.connectionId, rootNativeId: config.root.nativeId, collectionIds: [...config.collectionIds].sort(),
      installationGeneration: c.installationGeneration, sourceSessionGeneration: c.sourceSessionGeneration, policyRevision: policy.policy.revision };
    const authority = await siteLedger.db.read<SourceAuthority>('authorities', 'bundled.bilibili');
    if (!authority?.enabled || authority.connectionId !== c.connectionId || !authority.accountId) throw new Error('communityConnectedSourceRequired');
    const path: string[] = [], seen = new Set<string>(); let current: string | undefined = scope.rootNativeId;
    while (current && current !== '0') {
      if (seen.has(current) || seen.size >= 32) throw new Error('communityRootNeedsReview'); seen.add(current);
      const n: chrome.bookmarks.BookmarkTreeNode | undefined = (await chrome.bookmarks.get(current))[0]; if (!n || n.url || n.unmodifiable) throw new Error('communityRootNeedsReview');
      path.unshift(n.title); current = n.parentId;
    }
    const collections = await Promise.all(scope.collectionIds.map(async id => ({ id, title: (await siteLedger.db.read<{ entity: { title: string } }>('collections', sourceKey(c.connectionId, id)))?.entity.title ?? id })));
    const display = { accountId: authority.accountId, rootPath: path, collections };
    return { scope, display, generation: r.generation, packageDigest: r.approved.digest, digest: sourceDigest({ installationId: r.id, generation: r.generation, packageDigest: r.approved.digest, scope, display }), nativeWrites: 0 };
  }
  async function management(raw: unknown) {
    if (!validCommunityManagement(raw)) throw new Error('invalid'); await ports.ready();
    const input = raw as { kind: string; text: string; digest: string; installationId: string; enabled: boolean };
    if (previewSchema(raw)) {
      const preview = inspectCommunityPackage(input.text), old = (await communityStore.read()).find(r => r.approved.package.manifest.adapterId === preview.package.manifest.adapterId);
      await chrome.storage.session.set({ [PREVIEW]: { ...preview, expiresAt: Date.now() + 600000 } });
      return { ok: true, preview: { digest: preview.digest, bytes: preview.bytes, ...preview.package, previous: old ? { digest: old.approved.digest, manifest: old.approved.package.manifest, provenance: old.approved.package.provenance } : null, risk: COMMUNITY_RISK, publisherTrust: 'unverified' } };
    }
    if (reviewSchema(raw)) {
      const row = (await communityStore.read()).find(r => r.id === input.installationId), previous = row?.previous.find(p => p.digest === input.digest);
      if (!row || !previous) throw new Error('communityRollbackUnavailable');
      await chrome.storage.session.set({ [PREVIEW]: { rollback: true, installationId: row.id, generation: row.generation, digest: previous.digest, expiresAt: Date.now() + 600000 } });
      return { ok: true, preview: { digest: previous.digest, ...previous.package, risk: COMMUNITY_RISK, publisherTrust: 'unverified', rollback: true } };
    }
    if (installSchema(raw)) {
      const preview = (await chrome.storage.session.get(PREVIEW))[PREVIEW] as PackagePreview & { expiresAt: number } | undefined;
      if (!preview || preview.expiresAt <= Date.now() || preview.digest !== input.digest || inspectCommunityPackage(preview.text).digest !== input.digest) throw new Error('communityPreviewExpired');
      const previous = (await communityStore.read()).find(r => r.approved.package.manifest.adapterId === preview.package.manifest.adapterId);
      await communityStore.mutate(rows => {
        const r = rows.find(r => r.approved.package.manifest.adapterId === preview.package.manifest.adapterId);
        if (r) {
          if (r.approved.digest === preview.digest) return;
          if (r.approved.package.manifest.version === preview.package.manifest.version) throw new Error('communityVersionConflict');
          fenceCommunity(r); r.hostVersion = chrome.runtime.getManifest().version; r.previous = [r.approved, ...r.previous].slice(0, 3); r.approved = preview; r.error = null;
        } else {
          if (rows.length >= 8) throw new Error('communityCapacity');
          rows.push({ id: crypto.randomUUID(), generation: 1, credential: crypto.randomUUID() + crypto.randomUUID(), hostVersion: chrome.runtime.getManifest().version, enabled: false,
            approved: preview, previous: [], archive: null, leases: [], routes: {}, rate: { at: Date.now(), count: 0 }, lastReport: null, error: null });
        }
      });
      if (previous && previous.approved.digest !== preview.digest) await cleanup(previous);
      await chrome.storage.session.remove(PREVIEW);
    } else if (toggleSchema(raw)) {
      const old = (await communityStore.read()).find(r => r.id === input.installationId); if (!old) throw new Error('communityNotInstalled');
      if (input.enabled) await communityApiAvailable();
      const record = await communityStore.mutate(rows => { const r = rows.find(r => r.id === input.installationId)!; fenceCommunity(r, input.enabled); r.hostVersion = chrome.runtime.getManifest().version; r.error = null; return r; });
      await cleanup(old);
      if (input.enabled) try { await register(record); } catch (e) {
        await communityStore.mutate(rows => { const r = rows.find(r => r.id === input.installationId)!; fenceCommunity(r); r.error = 'communityRegistrationFailed'; }); throw e;
      }
    } else if (scopeSchema(raw)) {
      const preview = await scopePreview(input.installationId); if (preview.digest !== input.digest) throw new Error('communityScopeStale');
      await communityStore.mutate(rows => { const r = rows.find(r => r.id === input.installationId);
        if (!r?.enabled || r.generation !== preview.generation || r.approved.digest !== preview.packageDigest) throw new Error('communityScopeStale');
        r.archive = { ...preview.scope, digest: communityScopeDigest(preview.scope) }; });
      const record = (await communityStore.read()).find(r => r.id === input.installationId)!; await inject(record);
    } else if (idSchema(raw)) {
      if (input.kind.endsWith('.scopePreview')) return { ok: true, preview: await scopePreview(input.installationId) };
      const old = (await communityStore.read()).find(r => r.id === input.installationId);
      await communityStore.mutate(rows => { const index = rows.findIndex(r => r.id === input.installationId); if (index >= 0) rows.splice(index, 1); });
      if (old) await cleanup(old);
    } else if (rollbackSchema(raw)) {
      const old = (await communityStore.read()).find(r => r.id === input.installationId);
      const preview = (await chrome.storage.session.get(PREVIEW))[PREVIEW] as { rollback?: boolean; installationId: string; generation: number; digest: string; expiresAt: number } | undefined;
      if (!old || !preview?.rollback || preview.installationId !== old.id || preview.generation !== old.generation || preview.digest !== input.digest || preview.expiresAt <= Date.now()) throw new Error('communityPreviewExpired');
      await communityStore.mutate(rows => { const r = rows.find(r => r.id === input.installationId), previous = r?.previous.find(p => p.digest === input.digest);
        if (!r || !previous || inspectCommunityPackage(previous.text).digest !== previous.digest) throw new Error('communityRollbackUnavailable');
        fenceCommunity(r); r.hostVersion = chrome.runtime.getManifest().version; r.previous = [r.approved, ...r.previous.filter(p => p.digest !== previous.digest)].slice(0, 3); r.approved = previous; r.error = null;
      }); if (old) await cleanup(old);
      await chrome.storage.session.remove(PREVIEW);
    }
    let available = true, unavailable: string | null = null;
    try { await communityApiAvailable(); } catch (e) { available = false; unavailable = e instanceof Error ? e.message : 'communityUnavailable'; }
    return { ok: true, available, unavailable, browserToggle: 'Chrome 149+: Extensions → Details → Allow User Scripts', supportedMinimum: 149,
      installations: (await communityStore.read()).map(r => ({ id: r.id, generation: r.generation, enabled: r.enabled, digest: r.approved.digest,
        manifest: r.approved.package.manifest, provenance: r.approved.package.provenance, previous: r.previous.map(p => ({ digest: p.digest, version: p.package.manifest.version })),
        archive: r.archive, documents: r.leases.filter(l => l.expiresAt > Date.now()).length, lastReport: r.lastReport, error: r.error })) };
  }
  async function message(raw: unknown, sender: SiteSender) {
    if (!jsonBytes(raw, 16384) || !(bootstrapSchema(raw) || hintSchema(raw))) return { status: 'rejected', reason: 'invalid' };
    await ports.ready(); const scripts = await communityApiAvailable();
    if (!validSiteSender(sender, chrome.runtime.id)) return { status: 'rejected', reason: 'sender' };
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    if (!frame || frame.documentId !== sender.documentId || frame.documentLifecycle !== 'active' || new URL(frame.url).origin !== BILIBILI.origin) return { status: 'rejected', reason: 'sender' };
    const input = raw as { installationId: string; generation: number; credential: string; leaseId: string; capability: string; requestId: string; hint: MembershipHint };
    const accepted = await communityStore.mutate(rows => {
      const r = rows.find(r => r.id === input.installationId);
      if (!r?.enabled || r.hostVersion !== chrome.runtime.getManifest().version || r.generation !== input.generation || inspectCommunityPackage(r.approved.text).digest !== r.approved.digest) throw new Error('communityRevoked');
      if (!communityRegistrationMatches(r, scripts)) throw new Error('communityRegistrationChanged');
      if (Date.now() - r.rate.at >= 60000) r.rate = { at: Date.now(), count: 0 };
      if (r.rate.count >= 16) throw new Error('communityRateLimited'); r.rate.count++;
      r.leases = r.leases.filter(l => l.expiresAt > Date.now());
      if (bootstrapSchema(raw)) {
        if (r.credential !== input.credential || r.leases.length >= 32) throw new Error('communityCredentialRejected');
        const lease = { id: crypto.randomUUID(), capability: crypto.randomUUID() + crypto.randomUUID(), tabId: sender.tab.id, documentId: sender.documentId!,
          url: frame.url, routeEpoch: r.routes[String(sender.tab.id)] ?? 0, expiresAt: Date.now() + 60000 };
        r.leases = r.leases.filter(l => l.documentId !== sender.documentId); r.leases.push(lease);
        return { status: 'ready' as const, leaseId: lease.id, capability: lease.capability, expiresAt: lease.expiresAt, mode: r.archive ? 'archiveHints' : 'inspector' };
      }
      const lease = r.leases.find(l => l.id === input.leaseId && l.capability === input.capability && l.documentId === sender.documentId && l.tabId === sender.tab.id
        && l.url === frame.url && l.routeEpoch === (r.routes[String(sender.tab.id)] ?? 0));
      if (!lease || !aidFromItem(input.hint.itemId) || [...input.hint.added, ...input.hint.removed].some(id => !decimal(id))) throw new Error('communityLeaseRejected');
      r.lastReport = { at: Date.now(), mode: r.archive ? 'archiveHints' : 'inspector', itemId: input.hint.itemId };
      return { status: 'accepted' as const, origin: r.archive ? { installationId: r.id, generation: r.generation, scopeDigest: r.archive.digest, packageDigest: r.approved.digest } : null };
    });
    if (accepted.status === 'ready') return accepted;
    if (!accepted.origin) return { status: 'inspected', writes: false, models: false };
    const source = await ports.source(sender.tab.id); if (!source || source.context.documentId !== sender.documentId) throw new Error('communityConnectedSourceRequired');
    await assertCommunityArchive(accepted.origin, { connectionId: source.context.connectionId, collectionIds: [...input.hint.added, ...input.hint.removed] });
    const reply = await ports.enqueue({ ...source.context, communityOrigin: accepted.origin }, `community:${input.installationId}:${input.requestId}`, input.hint); ports.wake(); return reply;
  }
  async function navigated(tabId: number) {
    if (!(await communityStore.read()).some(r => r.enabled || r.leases.length)) return;
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
    const here = frame?.documentLifecycle === 'active' && new URL(frame.url).origin === BILIBILI.origin;
    await communityStore.mutate(rows => { for (const r of rows) {
      r.leases = r.leases.filter(l => l.tabId !== tabId && l.expiresAt > Date.now());
      if (here && r.enabled) r.routes[String(tabId)] = (r.routes[String(tabId)] ?? 0) + 1;
      const active = new Set(r.leases.map(l => String(l.tabId)));
      r.routes = Object.fromEntries(Object.entries(r.routes).filter(([key]) => active.has(key) || here && r.enabled && key === String(tabId)));
    } });
    if (!here) return;
    try { await communityApiAvailable(); for (const r of (await communityStore.read()).filter(r => r.enabled)) await inject(r, tabId); } catch { /* status exposes the disabled runtime */ }
  }
  function install() {
    let pending = 0;
    chrome.runtime.onUserScriptMessage?.addListener((raw, sender, respond) => {
      if (pending >= 16) { respond({ status: 'rejected', reason: 'communityCapacity' }); return false; }
      pending++;
      void message(raw, sender).then(respond, e => respond({ status: 'rejected', reason: e instanceof Error ? e.message : 'communityUnavailable' })).finally(() => { pending--; }); return true;
    });
    chrome.runtime.onUserScriptConnect?.addListener(port => { port.disconnect(); }); // No second spending/recipe protocol.
    chrome.runtime.onStartup.addListener(() => { void lane(() => reconcile()).catch(() => undefined); });
    chrome.runtime.onInstalled.addListener(details => { if (details.reason === 'update') void lane(() => reconcile(true)).catch(() => undefined); });
    chrome.permissions.onAdded.addListener(() => { void lane(() => reconcile()).catch(() => undefined); });
    chrome.permissions.onRemoved.addListener(() => { void communityStore.mutate(rows => { for (const r of rows) fenceCommunity(r); }).then(() => lane(() => reconcile())).catch(() => undefined); });
    chrome.tabs.onRemoved.addListener(tabId => { void lane(() => navigated(tabId)).catch(() => undefined); });
    void lane(() => reconcile()).catch(() => undefined);
  }
  async function manage(raw: unknown) {
    if (toggleSchema(raw) && !(raw as { enabled: boolean }).enabled || idSchema(raw) && (raw as { kind: string }).kind === 'known.community.remove') {
      await ports.ready(); const input = raw as { installationId: string; kind: string }; let old: CommunityInstallation | undefined;
      // A hung page or hostile cleanup must not delay the durable authority fence behind the browser-operation lane.
      await communityStore.mutate(rows => { const index = rows.findIndex(r => r.id === input.installationId); if (index < 0) return;
        old = structuredClone(rows[index]!); fenceCommunity(rows[index]!);
        if (input.kind === 'known.community.remove') rows.splice(index, 1);
      });
      if (old) void lane(() => cleanup(old!)).catch(() => undefined);
      return { ok: true, fenced: true };
    }
    return lane(() => management(raw));
  }
  return { management: manage, message, install,
    navigated: (tabId: number) => lane(() => navigated(tabId)), reconcile: (update = false) => lane(() => reconcile(update)) };
}
