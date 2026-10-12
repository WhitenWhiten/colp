import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions, EXTENSION_ID } from './extension-auth.js';
import type { CaptureTask } from '../src/capture/contracts.js';
test('AC-10 saves offline at the frozen position and keeps one receipt through worker restart', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-offline-')), extension = resolve(import.meta.dirname, '../dist/production');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const { page } = await openExtensionOptions(context); await page.locator('#nav-bookmarks').click();
    const message = { kind: 'known.capture.start', trigger: 'manual-popup', commandId: crypto.randomUUID(), userGesture: true,
      title: 'Offline captured bookmark', url: 'https://example.org/offline-capture?q=one#exact', saveAnother: false, allowUnverifiedCloud: true, insertPosition: 'top' };
    const send = <T>(value: unknown) => page.evaluate(input => chrome.runtime.sendMessage(input), value) as Promise<T>;
    expect(await send(message)).toMatchObject({ ok: false });
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known bookmark manager');
    await page.reload(); await page.locator('#nav-bookmarks').click();
    const parentNativeId = await page.evaluate(async () => {
      const root = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Offline destination' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'Existing first', url: 'https://example.org/existing-first' });
      return folder.id;
    });
    await context.setOffline(true);
    const input = { ...message, parentNativeId }, result = await send<{ ok: boolean; task: CaptureTask }>(input);
    expect(result.ok).toBe(true);
    await expect.poll(async () => (await send<{ task: CaptureTask }>({ kind: 'known.capture.get', captureId: result.task.captureId })).task.save).toBe('local-saved');
    const cdp = await context.newCDPSession(page); const targets = await cdp.send('Target.getTargets');
    const worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.includes(EXTENSION_ID));
    expect(worker).toBeTruthy(); await cdp.send('Target.closeTarget', { targetId: worker!.targetId }); await cdp.detach();
    const replay = await send<{ ok: boolean; task: CaptureTask }>(input);
    expect(replay.task.captureId).toBe(result.task.captureId); expect(replay.task.save).toBe('local-saved');
    expect(replay.task.sync).toBe('local-only'); expect(replay.task.automaticIntent).toBe(false);
    const children = await page.evaluate(parent => chrome.bookmarks.getChildren(parent), parentNativeId);
    expect(children).toHaveLength(2); expect(children[0]?.url).toBe(message.url);
    expect(await send({ ...input, commandId: crypto.randomUUID(), collectionId: 'wrong-collection' })).toMatchObject({ ok: false });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
