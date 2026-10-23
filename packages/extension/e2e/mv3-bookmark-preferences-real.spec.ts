import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions } from './extension-auth.js';
import { login } from './kns-08-harness.js';
import type { BookmarkPreferences, BookmarkPreferencesCacheRecord } from '../src/bookmark-preferences.js';
import type { BookmarkPreferencesRequest, BookmarkPreferencesResponse } from '../src/types.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const preferenceUrl = 'https://known.example/api/v1/me/bookmark-preferences';

test('L-06 real account preferences recover offline edits and expose a concurrent 412 without overwriting', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const stack = await startRealStack();
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  const patchResponses: { status: number; ifMatch: string | undefined; commandId: string | undefined }[] = [];
  try {
    contextA = await launch(stack.browserHostResolverRules);
    contextB = await launch(stack.browserHostResolverRules);
    contextA.on('response', response => {
      const request = response.request();
      if (response.url() === preferenceUrl && request.method() === 'PATCH') {
        patchResponses.push({ status: response.status(), ifMatch: request.headers()['if-match'],
          commandId: request.headers()['known-command-id'] });
      }
    });
    const pageA = (await openExtensionOptions(contextA)).page;
    const pageB = (await openExtensionOptions(contextB)).page;
    await login(pageA, stack.extensionBindings[0]);
    await login(pageB, stack.extensionBindings[1]);
    const originalServer = await serverRead(pageB);
    const initialA = await settledRead(pageA, { revision: originalServer.body.revision, etag: originalServer.etag });
    const initialB = await settledRead(pageB, { revision: initialA.revision, preferences: initialA.preferences });
    const offlineValue: BookmarkPreferences = { bookmarkInsertPosition: 'top', foldersFirst: false };

    // Browser A loses transport; B still reads the real account resource.
    await contextA.setOffline(true);
    const pending = await update(pageA, offlineValue);
    expect(pending).toMatchObject({ preferences: offlineValue, pending: true, conflict: false,
      revision: initialA.revision, etag: initialA.etag, scope: 'account' });
    const offlineRecord = await accountRecord(pageA);
    expect(offlineRecord.pending).toMatchObject({ value: offlineValue, ifMatch: initialA.etag,
      baseRevision: initialA.revision });
    expect(await serverRead(pageB)).toEqual(originalServer);

    await contextA.setOffline(false);
    await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => message(pageA, { kind: 'known.bookmark.preferences.get' }),
      { timeout: 30_000 }).toMatchObject({ preferences: offlineValue, pending: false, conflict: false });
    const recovered = await message(pageA, { kind: 'known.bookmark.preferences.local' });
    expect(recovered.revision).not.toBe(initialA.revision);
    expect(await serverRead(pageB)).toMatchObject({ body: { ...offlineValue, revision: recovered.revision }, etag: recovered.etag });
    // Account defaults arrive without replacing this browser's native-operation preferences.
    await settledRead(pageB, { preferences: initialB.preferences, accountDefaults: offlineValue, revision: recovered.revision });
    expect(patchResponses.some(row => row.status === 200
      && row.commandId === offlineRecord.pending?.commandId && row.ifMatch === initialA.etag)).toBe(true);

    // A keeps its old revision while offline; B commits a different value.
    await contextA.setOffline(true);
    const localValue: BookmarkPreferences = { bookmarkInsertPosition: 'bottom', foldersFirst: false };
    const remoteValue: BookmarkPreferences = { bookmarkInsertPosition: 'top', foldersFirst: true };
    expect(await update(pageA, localValue)).toMatchObject({ pending: true, conflict: false,
      revision: recovered.revision, preferences: localValue });
    const staleRecord = await accountRecord(pageA);
    await update(pageB, remoteValue);
    const writtenB = await settledRead(pageB, { preferences: remoteValue });
    expect(writtenB.revision).not.toBe(recovered.revision);
    const winningServer = await serverRead(pageB);
    expect(winningServer).toMatchObject({ body: { ...remoteValue, revision: writtenB.revision } });

    await contextA.setOffline(false);
    await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => message(pageA, { kind: 'known.bookmark.preferences.get' }),
      { timeout: 30_000 }).toMatchObject({ preferences: localValue, pending: false, conflict: true });
    const conflict = await accountRecord(pageA);
    expect(conflict.conflict).toMatchObject({ local: localValue, remote: remoteValue,
      remoteRevision: writtenB.revision, remoteEtag: writtenB.etag });
    expect(patchResponses.some(row => row.status === 412
      && row.commandId === staleRecord.pending?.commandId && row.ifMatch === recovered.etag)).toBe(true);
    expect(await serverRead(pageB)).toEqual(winningServer);

    // Ordinary reads/edits cannot silently clear the conflict or overwrite B.
    const patchesBeforeBlockedEdit = patchResponses.length;
    expect(await update(pageA, { bookmarkInsertPosition: 'bottom', foldersFirst: true }))
      .toMatchObject({ conflict: true, pending: false, preferences: localValue });
    expect(await message(pageA, { kind: 'known.bookmark.preferences.get' }))
      .toMatchObject({ conflict: true, preferences: localValue });
    expect(patchResponses).toHaveLength(patchesBeforeBlockedEdit);
    expect(await serverRead(pageB)).toEqual(winningServer);

    const resolved = await message(pageA, { kind: 'known.bookmark.preferences.resolve', userGesture: true, choice: 'server' });
    expect(resolved).toMatchObject({ preferences: remoteValue, revision: writtenB.revision,
      etag: writtenB.etag, pending: false, conflict: false });
    expect(patchResponses).toHaveLength(patchesBeforeBlockedEdit);
    expect(await serverRead(pageB)).toEqual(winningServer);
    await testInfo.attach('l06-preferences-authority', { contentType: 'application/json', body: JSON.stringify({
      initialA, initialB, originalServer, offlineRecord, recovered, staleRecord, writtenB,
      winningServer, conflict, resolved, patchResponses,
    }, null, 2) });
  } finally {
    await contextA?.close().catch(() => undefined);
    await contextB?.close().catch(() => undefined);
    await stack.close();
  }
});

function launch(resolver: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext('', { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${resolver}`, '--no-proxy-server', '--ignore-certificate-errors'] });
}

async function message(page: Page, request: BookmarkPreferencesRequest) {
  const response = await page.evaluate(payload => chrome.runtime.sendMessage(payload), request) as BookmarkPreferencesResponse;
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(response.error);
  return response;
}

function update(page: Page, preferences: BookmarkPreferences) {
  return message(page, { kind: 'known.bookmark.preferences.update', userGesture: true, ...preferences });
}

/** Preferences return their local projection immediately while Product HTTP runs in the background. */
async function settledRead(page: Page, expected: Record<string, unknown>) {
  let value = await message(page, { kind: 'known.bookmark.preferences.get' });
  await expect.poll(async () => {
    value = await message(page, { kind: 'known.bookmark.preferences.get' });
    return value;
  }, { timeout: 30_000 }).toMatchObject({ scope: 'account', pending: false, conflict: false, ...expected });
  return value;
}

async function serverRead(page: Page): Promise<{ status: number; etag: string | null; body: Record<string, unknown> }> {
  const result = await page.evaluate(async url => {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'error' });
    return { status: response.status, etag: response.headers.get('etag'), body: await response.json() as Record<string, unknown> };
  }, preferenceUrl);
  expect(result.status).toBe(200);
  return result;
}

async function accountRecord(page: Page): Promise<BookmarkPreferencesCacheRecord> {
  const records = await page.evaluate(async () => {
    const cache = (await chrome.storage.local.get('known.bookmark.preferences.v1'))['known.bookmark.preferences.v1'] as {
      records?: Record<string, BookmarkPreferencesCacheRecord> } | undefined;
    return Object.values(cache?.records ?? {}).filter(record => record.subject !== null);
  });
  expect(records).toHaveLength(1);
  return records[0]!;
}
