import { sendSiteMessage, offer } from './settings-client.js';
interface Reply { digest?: string; edges?: unknown[]; receipt?: unknown; error?: string; configured?: boolean; approved?: boolean; state?: string }
const summary = document.querySelector<HTMLPreElement>('#cloud-status')!;
let approval: string | undefined, plan: string | undefined;
async function call(action: string, trigger: HTMLButtonElement, input: Record<string, unknown> = {}) {
  const wasDisabled = trigger.disabled; trigger.disabled = true; trigger.setAttribute('aria-busy', 'true');
  try {
    const result = await sendSiteMessage({ kind: `known.siteAdapters.cloud.${action}`, ...input }) as Reply;
    summary.textContent = JSON.stringify(result, null, 2);
    const fold = summary.closest('details'); if (fold) fold.open = true;
    if (result.error) return;
    if (action === 'review') approval = result.digest;
    if (action === 'preview' || action === 'recover') plan = result.state === undefined || result.state === 'prepared' ? result.digest : undefined;
    if (action === 'commit' || action === 'approve' || action === 'revoke' || action === 'cancel' || action === 'configureRule') { plan = undefined; approval = undefined; }
    offer(document.querySelector<HTMLButtonElement>('#cloud-approve')!, !!approval);
    offer(document.querySelector<HTMLButtonElement>('#cloud-commit')!, !!plan);
  } finally {
    trigger.setAttribute('aria-busy', 'false');
    if (trigger.id !== 'cloud-approve' && trigger.id !== 'cloud-commit') trigger.disabled = wasDisabled;
  }
}
for (const action of ['status', 'review', 'preview', 'recover', 'revoke', 'cancel']) {
  const trigger = document.querySelector<HTMLButtonElement>(action === 'status' ? '#cloud-status-button' : `#cloud-${action}`)!;
  trigger.addEventListener('click', () => { void call(action, trigger).catch(e => { summary.textContent = String(e); }); });
}
const approveButton = document.querySelector<HTMLButtonElement>('#cloud-approve')!;
approveButton.addEventListener('click', () => { void call('approve', approveButton, { digest: approval }).catch(e => { summary.textContent = String(e); }); });
const commitButton = document.querySelector<HTMLButtonElement>('#cloud-commit')!;
commitButton.addEventListener('click', () => { void call('commit', commitButton, { digest: plan }).catch(e => { summary.textContent = String(e); }); });
const ruleButton = document.querySelector<HTMLButtonElement>('#cloud-rule')!;
ruleButton.addEventListener('click', () => {
  // The rule uses what the Sync tab has chosen: its folder picker and the ticked collections.
  const rootNativeId = document.querySelector<HTMLElement>('#archive-root')?.dataset.value ?? '';
  const collectionIds = Array.from(document.querySelectorAll<HTMLInputElement>('#archive-collections input:checked')).map(o => o.value);
  void call('configureRule', ruleButton, { rootNativeId, collectionIds }).catch(e => { summary.textContent = String(e); });
});
