import { BILIBILI } from './bilibili/identity.js';
const status = document.querySelector<HTMLPreElement>('#status')!;
const confirm = document.querySelector<HTMLButtonElement>('#confirm')!;
let candidate: string | null = null;
async function send(message: unknown) {
  const result = await chrome.runtime.sendMessage(message) as { candidateAccount?: string | null };
  candidate = result.candidateAccount ?? null; confirm.hidden = !candidate;
  document.querySelector('#connection')!.textContent = candidate ? `Detected account ${candidate}. Confirm the account you want to connect.` : '';
  status.textContent = JSON.stringify(result, null, 2);
}
document.querySelector('#enable')!.addEventListener('click', () => {
  void chrome.permissions.request({ permissions: ['scripting', 'webNavigation'], origins: [...BILIBILI.matches] }).then(granted => {
    if (granted) return send({ kind: 'known.siteAdapters.enable', enabled: true }); status.textContent = 'Site access is required.';
  }).catch(() => { status.textContent = 'Site access is unavailable.'; });
});
document.querySelector('#disable')!.addEventListener('click', () => { void send({ kind: 'known.siteAdapters.enable', enabled: false }); });
document.querySelector('#refresh')!.addEventListener('click', () => { void send({ kind: 'known.siteAdapters.status' }); });
confirm.addEventListener('click', () => { if (candidate) void send({ kind: 'known.siteAdapters.confirm', accountId: candidate }); });
void send({ kind: 'known.siteAdapters.status' });
