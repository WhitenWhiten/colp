import { siteButton, siteRow } from './settings-client.js';
import { COMMUNITY_PACKAGE_BYTES } from './community-package.js';
import type { CommunityManifest } from './community-definition.js';
import { createSiteMark } from './site-icon.js';
import { t } from '../i18n.js';
const element = <T extends Element>(id: string) => document.querySelector<T>(`#${id}`)!;
const ack = element<HTMLInputElement>('community-ack'), install = element<HTMLButtonElement>('community-install'), status = element<HTMLPreElement>('community-status');
let approval: { kind: 'known.community.install' | 'known.community.rollback'; digest: string; adapterId: string; installationId?: string } | null = null;
interface CommunityResponse {
  available?: boolean;
  preview?: { digest: string; rollback?: boolean; manifest: CommunityManifest; readonly [key: string]: unknown };
  installations?: { id: string; manifest: CommunityManifest; digest: string; error: string | null; previous: { digest: string; version: string }[] }[];
}
// COMMUNITY_RISK in this page's language (tests/site-adapter-settings-copy.test.ts keeps the English identical).
element('community-risk').textContent = t('sites_communityRisk', 'This code can read and alter authorized site pages, make requests using the site session, and expose visible private content. Install only code and authors you trust. You are responsible for this choice. Once you turn the site on, what it reports becomes bookmarks in the folder you choose.');
/** Replies land in Last response; it opens for a step the user took, not for the status read on load. */
async function request(message: unknown, reveal = true): Promise<CommunityResponse> {
  const r = await chrome.runtime.sendMessage(message) as CommunityResponse; status.textContent = JSON.stringify(r, null, 2);
  if (reveal) status.closest('details')!.open = true; return r;
}
/** A full load, so the sidebar and the site page read the installed packages again. */
function openSite(adapterId: string) {
  const next = new URL(`site-adapters.html?adapterId=${encodeURIComponent(adapterId)}#sync`, location.href);
  if (next.search !== location.search) { location.href = next.href; return; }
  location.hash = 'sync'; location.reload();
}
function packageProblem(code: string) {
  if (code === 'communityPackageOutdated') return t('sites_packageOutdated', 'This package uses the earlier hint-only format. Install an updated version to use it.');
  if (code === 'communitySiteKeyTaken') return t('sites_packageSiteTaken', 'Another installed package already uses this site identity.');
  return code;
}
/** The review block (package bytes, consent, Install) shows only while there is a package to approve. */
function reviewing(open: boolean) { element<HTMLElement>('community-review').hidden = !open; element<HTMLElement>('community-install-bar').hidden = !open; }
function preview(result: CommunityResponse, installationId?: string) {
  ack.checked = false; install.disabled = true; approval = null; reviewing(false);
  // The review block shows the package; a refusal is only in Last response, so open it.
  if (!result.preview) { status.closest('details')!.open = true; return; }
  element('community-preview').textContent = JSON.stringify(result.preview, null, 2);
  approval = { kind: result.preview.rollback ? 'known.community.rollback' : 'known.community.install', digest: result.preview.digest, adapterId: result.preview.manifest.adapterId,
    ...(installationId ? { installationId } : {}) };
  install.textContent = result.preview.rollback ? t('sites_approveRollback', 'Approve rollback') : t('sites_installReviewed', 'Install reviewed package'); reviewing(true);
}
async function refresh(reveal = false) {
  const result = await request({ kind: 'known.community.status' }, reveal), container = element('community-packages'); container.replaceChildren();
  if (typeof result.available === 'boolean') {
    element<HTMLElement>('community-dot').dataset.tone = result.available ? 'on' : 'off'; element('community-available').textContent = result.available ? t('sites_available', 'Available') : t('sites_off', 'Off');
  }
  for (const row of result.installations ?? []) {
    const label = row.manifest.label ?? row.manifest.adapterId, hosts = [...new Set((row.manifest.matches ?? []).map(m => { try { return new URL(m).hostname; } catch { return m; } }))];
    const { row: block, text, control } = siteRow(label, '', true), meta = document.createElement('p'), digest = document.createElement('span');
    const title = text.querySelector<HTMLElement>('.set-row-title')!, titleLine = document.createElement('div');
    titleLine.className = 'sites-package-title'; title.before(titleLine);
    titleLine.append(createSiteMark({ label, origin: hosts[0] ? `https://${hosts[0]}` : '', icon: row.manifest.icon, size: 20, className: 'sites-mark sites-package-mark' }), title);
    meta.className = 'set-row-hint'; digest.className = 'sites-package-digest'; digest.textContent = row.digest;
    meta.append(`${[t('sites_packageVersion', 'Version $1', row.manifest.version), ...hosts].join(' · ')} · `, digest);
    text.append(meta);
    if (row.error) { const alert = document.createElement('p'); alert.className = 'set-row-hint'; alert.dataset.tone = 'danger'; alert.textContent = packageProblem(row.error); text.append(alert); }
    else {
      // The package is a site now: it is turned on, connected and mapped from its own page, like a built-in site.
      const open = siteButton(t('sites_openPackageSite', 'Set up $1', label)); open.onclick = () => { openSite(row.manifest.adapterId); }; control.append(open);
    }
    for (const old of row.previous) {
      const button = siteButton(t('sites_reviewRollback', 'Review rollback to $1', old.version), 'ghost');
      button.onclick = () => { void request({ kind: 'known.community.reviewVersion', installationId: row.id, digest: old.digest }, false).then(r => preview(r, row.id)); }; control.append(button);
    }
    // Removing is the one step that can't be undone: it goes last, apart from the others.
    const remove = siteButton(t('sites_removePackage', 'Remove package'), 'ghost'); remove.classList.add('sites-package-remove');
    remove.onclick = () => { void request({ kind: 'known.community.remove', installationId: row.id }).then(() => { location.reload(); }); }; control.append(remove);
    container.append(block);
  }
}
element<HTMLInputElement>('community-file').onchange = () => { void (async () => {
  approval = null; ack.checked = false; install.disabled = true; reviewing(false);
  const file = element<HTMLInputElement>('community-file').files?.[0]; if (!file) return;
  if (file.size > COMMUNITY_PACKAGE_BYTES) throw new Error('packageTooLarge');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
  preview(await request({ kind: 'known.community.preview', text }, false));
})().catch(e => { status.textContent = String(e); status.closest('details')!.open = true; }); };
ack.onchange = () => { install.disabled = !approval || !ack.checked; };
install.onclick = () => {
  if (!approval || !ack.checked) return;
  const { adapterId, ...message } = approval; install.disabled = true;
  void request({ ...message, acknowledgeRisk: true }).then(result => {
    approval = null; ack.checked = false; reviewing(false);
    // The new or updated site appears in the sidebar; open it to turn it on.
    if (result.installations?.some(r => r.manifest.adapterId === adapterId && !r.error)) openSite(adapterId); else return refresh();
  });
};
element<HTMLButtonElement>('community-refresh').onclick = () => { void refresh(true); };
void refresh();
