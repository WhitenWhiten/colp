import { selectedSite } from './settings-client.js';
import { COMMUNITY_RISK, COMMUNITY_PACKAGE_BYTES } from './community-package.js';
const element = <T extends Element>(id: string) => document.querySelector<T>(`#${id}`)!;
const ack = element<HTMLInputElement>('community-ack'), install = element<HTMLButtonElement>('community-install'), status = element<HTMLPreElement>('community-status');
let approval: { kind: 'known.community.install' | 'known.community.rollback'; digest: string; installationId?: string } | null = null;
interface CommunityResponse {
  preview?: { digest: string; rollback?: boolean; readonly [key: string]: unknown };
  installations?: { id: string; manifest: { adapterId: string; version: string }; enabled: boolean; digest: string; archive: unknown;
    error: string | null; previous: { digest: string; version: string }[] }[];
}
element('community-risk').textContent = COMMUNITY_RISK;
async function request(message: unknown): Promise<CommunityResponse> {
  const r = await chrome.runtime.sendMessage(message) as CommunityResponse; status.textContent = JSON.stringify(r, null, 2); return r;
}
function preview(result: CommunityResponse, installationId?: string) {
  ack.checked = false; install.disabled = true; approval = null;
  if (!result.preview) return;
  element('community-preview').textContent = JSON.stringify(result.preview, null, 2);
  approval = { kind: result.preview.rollback ? 'known.community.rollback' : 'known.community.install', digest: result.preview.digest,
    ...(installationId ? { installationId } : {}) };
  install.textContent = result.preview.rollback ? 'Approve rollback (disabled)' : 'Install reviewed bytes (disabled)';
}
async function refresh() {
  const result = await request({ kind: 'known.community.status' }), container = element('community-packages'); container.replaceChildren();
  for (const row of result.installations ?? []) {
    const block = document.createElement('div'), title = document.createElement('p');
    title.textContent = `${row.manifest.adapterId} ${row.manifest.version}: ${row.enabled ? 'enabled' : 'disabled'}; ${row.digest}; archive ${row.archive ? 'scoped' : 'unavailable'}. ${row.error ?? ''}`; block.append(title);
    for (const [label, message] of [[row.enabled ? 'Disable package' : 'Enable inspector', { kind: 'known.community.enable', installationId: row.id, enabled: !row.enabled }],
      ['Remove package', { kind: 'known.community.remove', installationId: row.id }]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => { void request(message).then(refresh); }; block.append(button);
    }
    if (row.enabled) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Preview current archive scope for this package';
      button.onclick = () => { void request({ kind: 'known.community.scopePreview', installationId: row.id }).then(r => {
        if (!r.preview) return;
        const preview = r.preview;
        const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = 'Allow verified hints for exactly this archive scope';
        approve.onclick = () => { approve.disabled = true; void request({ kind: 'known.community.scopeApprove', installationId: row.id, digest: preview.digest }).then(refresh); }; block.append(approve);
      }); }; block.append(button);
    }
    for (const old of row.previous) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Review rollback to ${old.version}`;
      button.onclick = () => { void request({ kind: 'known.community.reviewVersion', installationId: row.id, digest: old.digest }).then(r => preview(r, row.id)); }; block.append(button);
    }
    container.append(block);
  }
}
element<HTMLInputElement>('community-file').onchange = () => { void (async () => {
  approval = null; ack.checked = false; install.disabled = true;
  const file = element<HTMLInputElement>('community-file').files?.[0]; if (!file) return;
  if (file.size > COMMUNITY_PACKAGE_BYTES) throw new Error('packageTooLarge');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
  preview(await request({ kind: 'known.community.preview', text }));
})().catch(e => { status.textContent = String(e); }); };
ack.onchange = () => { install.disabled = !approval || !ack.checked; };
install.onclick = () => { if (approval && ack.checked) { install.disabled = true; void request({ ...approval, acknowledgeRisk: true }).then(() => { approval = null; ack.checked = false; return refresh(); }); } };
element<HTMLButtonElement>('community-grant').onclick = () => { void chrome.permissions.request({ permissions: ['userScripts', 'webNavigation'], origins: [...selectedSite.matches] }).then(refresh).catch(e => { status.textContent = String(e); }); };
element<HTMLButtonElement>('community-refresh').onclick = () => { void refresh(); };
void refresh();
