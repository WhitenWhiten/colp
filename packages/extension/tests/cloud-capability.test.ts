// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyCloudOptionVisibility, loadManifestCloud, manifestCloudEnabled, manifestCloudIsOn, refreshCloudOptions, resetManifestCloudCache } from '../src/cloud-capability.js';

afterEach(() => { document.body.replaceChildren(); delete document.body.dataset.serverClassification; resetManifestCloudCache(); });

describe('manifest cloud', () => {
  test('a slow response from the previous server cannot overwrite the current capability cache', async () => {
    let oldReply!: (response: Response) => void;
    const old = loadManifestCloud('https://old.test', () => new Promise(resolve => { oldReply = resolve; }));
    const fetcher = vi.fn(async () => Response.json({ mounts: [{ features: { cloud: true } }] }));
    expect(await loadManifestCloud('https://new.test', fetcher)).toBe(true);
    oldReply(Response.json({ mounts: [{ features: { cloud: false } }] })); await old;
    expect(manifestCloudIsOn()).toBe(true);
    expect(await loadManifestCloud('https://new.test', fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('an obsolete page render does not apply login or navigation capabilities', async () => {
    const setLoginCloud = vi.fn(), setAccountViews = vi.fn();
    await refreshCloudOptions('https://old.test', { signedIn: false, isCurrent: () => false, setLoginCloud, setAccountViews },
      async () => Response.json({ mounts: [{ features: { cloud: false } }] }));
    expect(setLoginCloud).not.toHaveBeenCalled(); expect(setAccountViews).not.toHaveBeenCalled();
  });
  test('hosted manifests stay on and self-hosted cloud false is off', () => {
    expect(manifestCloudEnabled({ mounts: [{ features: { bookmarkUrls: {} } }] })).toBe(true);
    expect(manifestCloudEnabled({ mounts: [{ features: { cloud: false, transport: 'https' } }] })).toBe(false);
    expect(manifestCloudEnabled({ mounts: [{ 'https://know-n.com/colp/extensions/server': { cloud: false, transport: 'https' } }] })).toBe(false);
    expect(manifestCloudEnabled({ protocol: 'x' })).toBe(true);
  });

  test('hides credits, subscriptions, and server classification when cloud is absent', () => {
    document.body.innerHTML = `
      <a id="nav-subscriptions" href="#subscriptions">Subscriptions</a>
      <section><h2 id="account-credits-heading">Credits</h2></section>
      <div id="credits-card"></div>
      <label><input id="classification-source-know-n" type="radio"></label>
      <section id="pref-classification"></section>
      <div class="set-row"><span id="icon-policy"></span></div>
      <a data-diagnostics-category="subscriptions" href="#help">Subscriptions</a>`;
    document.body.dataset.pane = 'subscriptions';
    document.body.dataset.view = 'list';
    const hashes: string[] = [];
    applyCloudOptionVisibility({
      credits: false, subscriptions: false, serverClassification: false, faviconUpload: false, signedIn: true,
      navigate: (hash) => hashes.push(hash),
      setAccountViews: () => undefined,
    });
    const hidden = (node: Element | null) => node instanceof HTMLElement && node.hidden;
    expect(hidden(document.getElementById('nav-subscriptions'))).toBe(true);
    expect(hidden(document.getElementById('account-credits-heading')?.closest('section') ?? null)).toBe(true);
    expect(hidden(document.getElementById('classification-source-know-n')?.closest('label') ?? null)).toBe(true);
    expect(hidden(document.getElementById('pref-classification'))).toBe(true);
    expect(hidden(document.getElementById('icon-policy')?.closest('.set-row') ?? null)).toBe(true);
    expect(document.body.dataset.serverClassification).toBe('off');
    expect(hashes).toEqual(['#bookmarks']);
  });
});
