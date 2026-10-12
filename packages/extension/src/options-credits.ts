import { parseHubRoute } from './options-router.js';
import { AUTHORITY_GENERATION_KEY } from './authority-fence.js';
import { AUTH_SNAPSHOT, parseAuthSnapshot } from './auth-snapshot.js';
import { manifestCloudIsOn } from './cloud-capability.js';
import { bindCreditsLedger, createCreditOverviewClient, resolveCreditBusinessAccountId, type CreditAuthority } from './credits-ledger.js';
import type { ExtensionResponse } from './types.js';
import { t } from './i18n.js';

export function bindOptionsCredits(root: HTMLElement, request: () => Promise<ExtensionResponse>) {
  // "← Account", or back to wherever the reader came from (a deep link carries `return`).
  const back = root.querySelector<HTMLAnchorElement>('#credits-back'), backLabel = back?.querySelector('span');
  let identityCache: { readonly key: string; readonly accountId: string } | undefined;
  let activation: Promise<void> | undefined;
  let activationKey = '';
  async function getAuthority(signal?: AbortSignal): Promise<CreditAuthority> {
    const response = await request(); const state = response.state;
    const raw = (await chrome.storage.local.get(AUTHORITY_GENERATION_KEY))[AUTHORITY_GENERATION_KEY];
    const generation = raw && typeof raw === 'object' && Number.isSafeInteger((raw as { generation?: unknown }).generation)
      ? Number((raw as { generation: number }).generation) : 0;
    const credential = (await chrome.storage.session.get('known.auth.credential.v1'))['known.auth.credential.v1'];
    const accountKey = credential && typeof credential === 'object' && typeof (credential as { subject?: unknown }).subject === 'string'
      ? (credential as { subject: string }).subject : '';
    if (state.status !== 'connected' || !state.serverOrigin || !accountKey) {
      identityCache = undefined;
      return { status: state.status, serverOrigin: state.serverOrigin, accountKey, businessAccountId: '', generation };
    }
    const key = `${state.serverOrigin}|${accountKey}|${generation}`;
    if (identityCache?.key !== key) {
      identityCache = undefined;
      try { identityCache = { key, accountId: await resolveCreditBusinessAccountId({ serverOrigin: state.serverOrigin, expectedSubject: accountKey, signal }) }; }
      catch { /* The ledger remains empty until the session identity can be confirmed. */ }
    }
    const businessAccountId = identityCache?.key === key ? identityCache.accountId : '';
    return { status: state.status, serverOrigin: state.serverOrigin, accountKey, businessAccountId, generation };
  }
  const ledger = bindCreditsLedger({ root, getAuthority, cloudEnabled: manifestCloudIsOn });
  const overview = createCreditOverviewClient({ getAuthority, cloudEnabled: manifestCloudIsOn });
  chrome.storage.onChanged.addListener((changes, area) => {
    const authChange = changes[AUTH_SNAPSHOT];
    const before = authChange ? parseAuthSnapshot(authChange.oldValue) : undefined;
    const after = authChange ? parseAuthSnapshot(authChange.newValue) : undefined;
    const serverOrStatusChanged = Boolean(authChange && (before?.serverOrigin !== after?.serverOrigin || before?.status !== after?.status));
    if ((area === 'local' && (changes[AUTHORITY_GENERATION_KEY] || serverOrStatusChanged))
      || (area === 'session' && changes['known.auth.credential.v1'])) {
      identityCache = undefined; activationKey = ''; ledger.clear();
      if (!root.hidden) queueMicrotask(() => { void activate(); });
    }
  });
  async function activate(): Promise<void> {
    const key = `${location.pathname}|${location.search}|${location.hash}`;
    if (activationKey === key) return;
    activationKey = key;
    const route = parseHubRoute(location.hash), returnTo = route.params.get('return');
    if (back) back.href = returnTo ? `#${returnTo}` : '#account';
    if (backLabel) backLabel.textContent = returnTo ? t('common_back', 'Back') : t('common_account', 'Account');
    const chargeId = route.params.get('chargeId') ?? undefined, runId = route.params.get('runId') ?? undefined;
    for (const [name, value] of [['chargeId', chargeId], ['runId', runId]]) { const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`); if (input) input.value = value ?? ''; }
    await ledger.loadFirstPage({ limit: 20, ...(chargeId ? { chargeId } : {}), ...(runId ? { runId } : {}) });
    const entryId = new URLSearchParams(location.search).get('creditEntryId');
    if (entryId) await ledger.loadDetail(entryId);
  }
  return Object.freeze({
    activate: () => {
      if (activation) return activation;
      activation = activate().finally(() => { activation = undefined; });
      return activation;
    },
    clear: ledger.clear,
    /** The balance for the Account page's summary row. */
    loadOverview: (signal?: AbortSignal) => overview.load(signal),
  });
}
