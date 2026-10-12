import { formatMoment, t, tn } from './i18n.js';
import { AUTHORITY_GENERATION_KEY } from './authority-fence.js';
import { AUTH_SNAPSHOT, parseAuthSnapshot } from './auth-snapshot.js';
import { loadManifestCloud, manifestCloudIsOn } from './cloud-capability.js';
import { createCreditOverviewClient, resolveCreditBusinessAccountId, type CreditAuthority } from './credits-ledger.js';
import type { PublicAuthState } from './types.js';

/* The popup's credits card was removed in the slimmed-down layout; every
   element is optional so the price read that managed classification still
   needs keeps working without any DOM. */
export function bindPopupCredits(elements: {
  readonly summary: HTMLElement | null;
  readonly available: HTMLElement | null;
  readonly reserved: HTMLElement | null;
  readonly price: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly open: HTMLButtonElement | null;
}, getAuthState: () => PublicAuthState | undefined) {
  let current: PublicAuthState | undefined;
  let requestEpoch = 0;
  let controller: AbortController | undefined;
  let identityCache: { readonly key: string; readonly accountId: string } | undefined;
  const client = createCreditOverviewClient({
    cloudEnabled: manifestCloudIsOn,
    async getAuthority(signal?: AbortSignal): Promise<CreditAuthority> {
      const state = current ?? getAuthState();
      if (!state) return { status: 'connecting', serverOrigin: '', accountKey: '', businessAccountId: '', generation: 0 };
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
        catch { /* The summary remains unavailable until the account can be confirmed. */ }
      }
      return { status: state.status, serverOrigin: state.serverOrigin, accountKey,
        businessAccountId: identityCache?.key === key ? identityCache.accountId : '', generation };
    },
  });
  const write = (node: HTMLElement | null, text: string): void => { if (node) node.textContent = text; };
  const writePriceVersion = (version: string): void => { if (elements.price) elements.price.dataset.priceVersion = version; };
  elements.open?.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#credits') }); });
  chrome.storage.onChanged.addListener((changes, area) => {
    const authChange = changes[AUTH_SNAPSHOT];
    const before = authChange ? parseAuthSnapshot(authChange.oldValue) : undefined;
    const after = authChange ? parseAuthSnapshot(authChange.newValue) : undefined;
    const serverOrStatusChanged = Boolean(authChange && (before?.serverOrigin !== after?.serverOrigin || before?.status !== after?.status));
    if ((area === 'local' && (changes[AUTHORITY_GENERATION_KEY] || serverOrStatusChanged))
      || (area === 'session' && changes['known.auth.credential.v1'])) { identityCache = undefined; clear(); void refresh(); }
  });
  function clear(): void {
    requestEpoch += 1; controller?.abort(); controller = undefined;
    write(elements.available, '-'); write(elements.reserved, '-'); write(elements.price, '-');
    writePriceVersion(''); write(elements.status, '');
  }
  async function refresh(): Promise<void> {
    if (current?.status !== 'connected') return;
    controller?.abort();
    const requestController = new AbortController(); controller = requestController;
    const epoch = ++requestEpoch; if (elements.summary) elements.summary.hidden = false;
    write(elements.available, '-'); write(elements.reserved, '-'); write(elements.price, '-');
    writePriceVersion(''); write(elements.status, t('common_loading', 'Loading…'));
    try {
      if (current?.serverOrigin) await loadManifestCloud(current.serverOrigin);
      const overview = await client.load(requestController.signal);
      if (overview === 'unsupported') { if (elements.summary) elements.summary.hidden = true; return; }
      if (epoch !== requestEpoch || requestController.signal.aborted) return;
      write(elements.available, String(overview.balance.available));
      write(elements.reserved, String(overview.balance.reserved));
      const price = overview.prices.find((item) => item.operationType === 'bookmark.classify');
      write(elements.price, price ? tn('credits_upToPoints', price.unitPoints, 'Up to $1 point', 'Up to $1 points') : t('common_unavailable', 'Unavailable'));
      writePriceVersion(price?.priceVersion ?? '');
      write(elements.status, overview.balance.nextExpiryAt ? t('credits_nextExpiry', 'Next expiry $1.', formatMoment(overview.balance.nextExpiryAt, 'date')) : '');
    } catch (error) {
      if (epoch !== requestEpoch || requestController.signal.aborted) return;
      write(elements.available, '-'); write(elements.reserved, '-'); write(elements.price, '-');
      writePriceVersion('');
      write(elements.status, error instanceof TypeError ? t('credits_creditsAreOffline', 'Credits are offline.') : t('credits_creditsUnavailableOpenCredits', 'Credits are unavailable. Open Credits in settings to retry.'));
    } finally {
      if (controller === requestController) controller = undefined;
    }
  }
  async function readPrice(): Promise<{ readonly priceVersion: string; readonly unitPoints: number }> {
    if (current?.serverOrigin) await loadManifestCloud(current.serverOrigin);
    const overview = await client.load();
    if (overview === 'unsupported') throw new Error('credit_price_unavailable');
    const price = overview.prices.find((item) => item.operationType === 'bookmark.classify');
    if (!price) throw new Error('credit_price_unavailable');
    write(elements.price, tn('credits_upToPoints', price.unitPoints, 'Up to $1 point', 'Up to $1 points'));
    writePriceVersion(price.priceVersion);
    return { priceVersion: price.priceVersion, unitPoints: price.unitPoints };
  }
  return Object.freeze({
    render(state: PublicAuthState): void {
      current = state;
      if (state.status === 'connected') { clear(); if (elements.summary) elements.summary.hidden = false; void refresh(); }
      else { clear(); if (elements.summary) elements.summary.hidden = true; }
    },
    refresh,
    readPrice,
  });
}
