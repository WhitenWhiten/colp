import type { Page, Worker } from '@playwright/test';
import { DEFAULT_BOOKMARK_PREFERENCES } from '../src/bookmark-preferences.js';

/** Controlled Product responses and identity; no real account or external service is used. */
export async function interceptPreferenceNetwork(worker: Worker) {
  await worker.evaluate(preferences => {
    const original = fetch;
    const state = globalThis as typeof globalThis & { fixtureHoldPatch?: boolean; fixturePatchStarted?: boolean; fixtureReleasePatch?: () => void };
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json', ...headers } });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('chrome-extension://')) return original(input, init);
      if (url.endsWith('/api/v1/session')) return json({ authenticated: true, csrfToken: 'fixture-csrf' });
      if (url.endsWith('/api/v1/auth/get-session')) return json({ user: { id: 'a'.repeat(32) }, session: { id: 'fixture-session' } });
      if (url.endsWith('/api/v1/me/bookmark-preferences')) {
        if (init?.method === 'PATCH') {
          state.fixturePatchStarted = true;
          if (state.fixtureHoldPatch) return new Promise<Response>(resolve => {
            state.fixtureReleasePatch = () => { state.fixtureHoldPatch = false; resolve(json({ error: { code: 'fixture-unavailable' } }, 503)); };
            init.signal?.addEventListener('abort', state.fixtureReleasePatch, { once: true });
          });
          return json({ error: { code: 'fixture-unavailable' } }, 503);
        }
        return json({ ...preferences, revision: '1' }, 200, { ETag: '"1"', 'Known-Bookmark-Session': 'fixture-session' });
      }
      return json({ error: { code: 'fixture-no-cloud' } }, 503);
    };
  }, DEFAULT_BOOKMARK_PREFERENCES);
}

export async function setPreferenceAccount(page: Page) {
  await page.evaluate(async () => {
    const config = await fetch(chrome.runtime.getURL('generated-config.json')).then(response => response.json());
    const authority = (await chrome.storage.local.get('known.auth.authority-generation.v1'))['known.auth.authority-generation.v1'] as { generation?: number } | undefined;
    await chrome.storage.session.set({ 'known.auth.credential.v1': { accessToken: 'preference-fixture', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600000, scope: ['known.sync'], issuer: config.issuer, audience: config.audience,
      clientId: config.clientId, serverOrigin: config.serverOrigin, subject: 'a'.repeat(32), authorityGeneration: authority?.generation ?? 0 } });
  });
}
