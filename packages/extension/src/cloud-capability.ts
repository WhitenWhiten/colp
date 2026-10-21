/**
 * Self-hosted COLP sets `features.cloud` false on the publication mount and
 * reports capture automation off. Hosted manifests omit the key.
 */
import { readBoundedJson } from './json-response.js';
import { assertCredentialHostPermission, SERVER_HOST_PERMISSION_ERROR } from './server-origin-permission.js';
const MANIFEST_PATH = '/.well-known/collection-protocol';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True unless a mount explicitly sets `features.cloud` to false. */
export function manifestCloudEnabled(body: unknown): boolean {
  if (!record(body) || !Array.isArray(body.mounts)) return true;
  return !body.mounts.some((mount) => {
    if (!record(mount)) return false;
    const extension = mount['https://know-n.com/colp/extensions/server'];
    return (record(extension) && extension.cloud === false)
      || (record(mount.features) && mount.features.cloud === false);
  });
}

/** Capture-capabilities is a cloud feature only when folder or tag automation is on. */
export function captureCloudEnabled(body: unknown): boolean {
  if (!record(body)) return false;
  return body.automaticFolderAvailable === true || body.automaticTagsAvailable === true;
}

let cachedOrigin = '';
let cachedCloud: boolean | undefined;
let pendingCloud: Promise<boolean> | undefined;

/** False only after a manifest read for this origin said cloud is off. Unknown stays on. */
export function manifestCloudIsOn(): boolean {
  return cachedCloud !== false;
}

export function resetManifestCloudCache(): void {
  cachedOrigin = '';
  cachedCloud = undefined;
  pendingCloud = undefined;
}

/** Public manifest read. A missing or unreadable manifest does not hide hosted features. */
export async function loadManifestCloud(origin: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!origin) return true;
  if (origin === cachedOrigin && cachedCloud !== undefined) return cachedCloud;
  if (origin === cachedOrigin && pendingCloud) return pendingCloud;
  cachedOrigin = origin;
  cachedCloud = undefined;
  const operation = readManifestCloud(origin, fetcher);
  pendingCloud = operation;
  const cloud = await operation;
  if (pendingCloud === operation) { cachedCloud = cloud; pendingCloud = undefined; }
  return cloud;
}

async function readManifestCloud(origin: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(5_000);
    const response = await fetcher(`${origin.replace(/\/$/u, '')}${MANIFEST_PATH}`, {
      redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/vnd.collection-protocol.manifest+json' },
      signal,
    });
    if (!response.ok) return true;
    return manifestCloudEnabled(await readBoundedJson(response, 512 * 1_024, 'manifest_invalid', { signal }));
  } catch { return true; }
}

export interface CloudOptionVisibility {
  readonly credits: boolean;
  readonly subscriptions: boolean;
  readonly serverClassification: boolean;
  readonly faviconUpload: boolean;
  readonly signedIn: boolean;
  readonly navigate?: (hash: string) => void;
  readonly setAccountViews?: (views: readonly ('session' | 'credits')[]) => void;
  readonly setLoginCloud?: (cloud: boolean) => void;
  readonly isCurrent?: () => boolean;
}

/** Hides credits, subscriptions, server classification, and favicon upload when absent. */
export function applyCloudOptionVisibility(input: CloudOptionVisibility): void {
  const credits = document.getElementById('account-credits-heading')?.closest('section');
  if (credits) credits.hidden = !input.credits;
  const creditsCard = document.getElementById('credits-card');
  if (creditsCard && !input.credits) creditsCard.hidden = true;
  const subscriptions = document.getElementById('nav-subscriptions');
  if (subscriptions) subscriptions.hidden = !input.subscriptions;
  const subscriptionsHelp = document.querySelector<HTMLElement>('[data-diagnostics-category="subscriptions"]');
  if (subscriptionsHelp) subscriptionsHelp.hidden = !input.subscriptions;
  const knowN = document.getElementById('classification-source-know-n')?.closest('label');
  if (knowN) knowN.hidden = !input.serverClassification;
  const knowNGroup = document.getElementById('pref-classification');
  if (!input.serverClassification) {
    if (knowNGroup) knowNGroup.hidden = true;
    document.body.dataset.serverClassification = 'off';
  } else delete document.body.dataset.serverClassification;
  const iconRow = document.getElementById('icon-policy')?.closest('.set-row');
  if (iconRow instanceof HTMLElement) iconRow.hidden = !input.faviconUpload;
  input.setAccountViews?.(input.signedIn && input.credits ? ['session', 'credits'] : ['session']);
  if (!input.subscriptions && document.body.dataset.pane === 'subscriptions') input.navigate?.('#bookmarks');
  else if (!input.credits && document.body.dataset.pane === 'account' && document.body.dataset.view === 'credits') input.navigate?.('#account');
}

/** Reads the manifest and, when signed in, capture-capabilities and the credits route. */
export async function refreshCloudOptions(origin: string, hooks: Omit<CloudOptionVisibility, 'credits' | 'subscriptions' | 'serverClassification' | 'faviconUpload'>, fetcher: typeof fetch = fetch): Promise<void> {
  const cloud = origin ? await loadManifestCloud(origin, fetcher) : true;
  if (hooks.isCurrent && !hooks.isCurrent()) return;
  hooks.setLoginCloud?.(cloud);
  let classification = cloud;
  let credits = cloud;
  if (cloud && origin && hooks.signedIn) {
    classification = await probeJson(origin, '/api/v1/me/capture-capabilities', fetcher, captureCloudEnabled);
    credits = await probeStatus(origin, '/api/v1/me/credits', fetcher);
  }
  if (!hooks.isCurrent || hooks.isCurrent()) {
    applyCloudOptionVisibility({ ...hooks, credits, subscriptions: cloud, serverClassification: classification, faviconUpload: cloud });
  }
}

async function probeStatus(origin: string, path: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const url = `${origin.replace(/\/$/u, '')}${path}`;
    const init: RequestInit = {
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000),
    };
    await assertCredentialHostPermission(url, init);
    const response = await fetcher(url, init);
    void response.body?.cancel().catch(() => undefined);
    return response.status !== 404;
  } catch (error) {
    if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) return false;
    return true;
  }
}

async function probeJson(origin: string, path: string, fetcher: typeof fetch, enabled: (body: unknown) => boolean): Promise<boolean> {
  try {
    const url = `${origin.replace(/\/$/u, '')}${path}`;
    const init: RequestInit = {
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000),
    };
    await assertCredentialHostPermission(url, init);
    const response = await fetcher(url, init);
    if (response.status === 404) return false;
    if (!response.ok) return true;
    return enabled(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) return false;
    return true;
  }
}
