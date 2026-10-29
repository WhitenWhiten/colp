import { selectedSite, siteButton, siteRow } from './settings-client.js';
import { COMMUNITY_PACKAGE_BYTES } from './community-package.js';
import { bundledSites } from './registry.js';
import { createSiteMark } from './site-icon.js';
import { t } from '../i18n.js';
import type { AdapterIcon } from './contracts.js';
const element = <T extends Element>(id: string) => document.querySelector<T>(`#${id}`)!;
const ack = element<HTMLInputElement>('community-ack'), install = element<HTMLButtonElement>('community-install'), status = element<HTMLPreElement>('community-status');
let approval: { kind: 'known.community.install' | 'known.community.rollback'; digest: string; installationId?: string } | null = null;
interface CommunityResponse {
  available?: boolean;
  preview?: { digest: string; rollback?: boolean; readonly [key: string]: unknown };
  installations?: { id: string; manifest: { adapterId: string; version: string; siteKey: string; identityVersion: number; icon?: AdapterIcon }; enabled: boolean; digest: string; archive: unknown;
    error: string | null; previous: { digest: string; version: string }[] }[];
}
// COMMUNITY_RISK in this page's language (tests/site-adapter-settings-copy.test.ts keeps the English identical).
element('community-risk').textContent = t('sites_communityRisk', 'This code can read and alter authorized site pages, make requests using the site session, and expose visible private content. Install only code and authors you trust. You are responsible for this choice. Inspector mode blocks host writes, but does not make unknown page code safe.');
/** Replies land in Last response; it opens for a step the user took, not for the status read on load. */
async function request(message: unknown, reveal = true): Promise<CommunityResponse> {
  const r = await chrome.runtime.sendMessage(message) as CommunityResponse; status.textContent = JSON.stringify(r, null, 2);
  if (reveal) status.closest('details')!.open = true; return r;
}
/** The review block (package bytes, consent, Install) shows only while there is a package to approve. */
function reviewing(open: boolean) { element<HTMLElement>('community-review').hidden = !open; element<HTMLElement>('community-install-bar').hidden = !open; }
function preview(result: CommunityResponse, installationId?: string) {
  ack.checked = false; install.disabled = true; approval = null; reviewing(false);
  // The review block shows the package; a refusal is only in Last response, so open it.
  if (!result.preview) { status.closest('details')!.open = true; return; }
  element('community-preview').textContent = JSON.stringify(result.preview, null, 2);
  approval = { kind: result.preview.rollback ? 'known.community.rollback' : 'known.community.install', digest: result.preview.digest,
    ...(installationId ? { installationId } : {}) };
  install.textContent = result.preview.rollback ? t('sites_approveRollback', 'Approve rollback (disabled)') : t('sites_installReviewed', 'Install reviewed bytes (disabled)'); reviewing(true);
}
async function refresh(reveal = false) {
  const result = await request({ kind: 'known.community.status' }, reveal), container = element('community-packages'); container.replaceChildren();
  if (typeof result.available === 'boolean') {
    element<HTMLElement>('community-dot').dataset.tone = result.available ? 'on' : 'off'; element('community-available').textContent = result.available ? t('sites_available', 'Available') : t('sites_off', 'Off');
  }
  for (const row of result.installations ?? []) {
    const { row: block, text, control } = siteRow(row.manifest.adapterId, '', true), meta = document.createElement('p'), digest = document.createElement('span');
    const definition = bundledSites.find(s => s.siteKey === row.manifest.siteKey && s.identityVersion === row.manifest.identityVersion);
    const title = text.querySelector<HTMLElement>('.set-row-title')!, titleLine = document.createElement('div');
    titleLine.className = 'sites-package-title'; title.before(titleLine);
    titleLine.append(createSiteMark({ label: definition?.label ?? row.manifest.adapterId, origin: definition?.origin ?? '', icon: row.manifest.icon,
      size: 20, className: 'sites-mark sites-package-mark' }), title);
    meta.className = 'set-row-hint'; digest.className = 'sites-package-digest'; digest.textContent = row.digest;
    meta.append(`${[t('sites_packageVersion', 'Version $1', row.manifest.version), row.enabled ? t('sites_packageEnabled', 'Enabled') : t('sites_packageDisabled', 'Disabled'),
      row.archive ? t('sites_archiveScoped', 'Archive scoped') : t('sites_archiveUnavailable', 'Archive unavailable')].join(' · ')} · `, digest);
    text.append(meta);
    if (row.error) { const alert = document.createElement('p'); alert.className = 'set-row-hint'; alert.dataset.tone = 'danger'; alert.textContent = row.error; text.append(alert); }
    const toggle = siteButton(row.enabled ? t('sites_disablePackage', 'Disable package') : t('sites_enablePackage', 'Enable inspector'));
    toggle.onclick = () => { void request({ kind: 'known.community.enable', installationId: row.id, enabled: !row.enabled }).then(() => refresh(true)); }; control.append(toggle);
    if (row.enabled) {
      const button = siteButton(t('sites_previewScope', 'Preview archive scope'));
      button.onclick = () => { void request({ kind: 'known.community.scopePreview', installationId: row.id }).then(r => {
        if (!r.preview) return;
        const preview = r.preview;
        const approve = siteButton(t('sites_allowHints', 'Allow verified hints for exactly this archive scope'), 'primary');
        approve.onclick = () => { approve.disabled = true; void request({ kind: 'known.community.scopeApprove', installationId: row.id, digest: preview.digest }).then(() => refresh(true)); }; button.after(approve);
      }); }; control.append(button);
    }
    for (const old of row.previous) {
      const button = siteButton(t('sites_reviewRollback', 'Review rollback to $1', old.version), 'ghost');
      button.onclick = () => { void request({ kind: 'known.community.reviewVersion', installationId: row.id, digest: old.digest }, false).then(r => preview(r, row.id)); }; control.append(button);
    }
    // Removing is the one step that can't be undone: it goes last, apart from the others.
    const remove = siteButton(t('sites_removePackage', 'Remove package'), 'ghost'); remove.classList.add('sites-package-remove');
    remove.onclick = () => { void request({ kind: 'known.community.remove', installationId: row.id }).then(() => refresh(true)); }; control.append(remove);
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
install.onclick = () => { if (approval && ack.checked) { install.disabled = true; void request({ ...approval, acknowledgeRisk: true }).then(() => { approval = null; ack.checked = false; reviewing(false); return refresh(); }); } };
element<HTMLButtonElement>('community-grant').onclick = () => { void chrome.permissions.request({ permissions: ['userScripts', 'webNavigation'], origins: [...selectedSite.matches] }).then(() => refresh(true)).catch(e => { status.textContent = String(e); }); };
element<HTMLButtonElement>('community-refresh').onclick = () => { void refresh(true); };
void refresh();
