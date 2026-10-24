import { sendSiteMessage } from './settings-client.js';
interface Reply { digest?: string; edges?: unknown[]; receipt?: unknown; error?: string; configured?: boolean; approved?: boolean; state?: string }
const summary = document.querySelector<HTMLPreElement>('#cloud-status')!;
let approval: string | undefined, plan: string | undefined;
async function call(action: string, input: Record<string, unknown> = {}) {
  const result = await sendSiteMessage({ kind: `known.siteAdapters.cloud.${action}`, ...input }) as Reply;
  summary.textContent = JSON.stringify(result, null, 2);
  if (result.error) return;
  if (action === 'review') approval = result.digest;
  if (action === 'preview' || action === 'recover') plan = result.state === undefined || result.state === 'prepared' ? result.digest : undefined;
  if (action === 'commit' || action === 'approve' || action === 'revoke' || action === 'cancel' || action === 'configureRule') { plan = undefined; approval = undefined; }
  document.querySelector<HTMLButtonElement>('#cloud-approve')!.disabled = !approval;
  document.querySelector<HTMLButtonElement>('#cloud-commit')!.disabled = !plan;
}
for (const action of ['status', 'review', 'preview', 'recover', 'revoke', 'cancel']) document.querySelector(action === 'status' ? '#cloud-status-button' : `#cloud-${action}`)!.addEventListener('click', () => {
  void call(action).catch(e => { summary.textContent = String(e); });
});
document.querySelector('#cloud-approve')!.addEventListener('click', () => { void call('approve', { digest: approval }).catch(e => { summary.textContent = String(e); }); });
document.querySelector('#cloud-commit')!.addEventListener('click', () => { void call('commit', { digest: plan }).catch(e => { summary.textContent = String(e); }); });
document.querySelector('#cloud-rule')!.addEventListener('click', () => {
  const rootNativeId = document.querySelector<HTMLSelectElement>('#archive-root')!.value;
  const collectionIds = Array.from(document.querySelector<HTMLSelectElement>('#archive-collections')!.selectedOptions).map(o => o.value);
  void call('configureRule', { rootNativeId, collectionIds }).catch(e => { summary.textContent = String(e); });
});
