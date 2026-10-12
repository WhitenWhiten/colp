import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const extensionPath = resolve(import.meta.dirname, '../dist/production');
const evidencePath = resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture');

test('AC-06 renders compact, expanded and pending prototypes with shared recipes and no capture writes', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-panel-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.addInitScript(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      (globalThis as unknown as { captureWrites: unknown[] }).captureWrites = [];
      chrome.runtime.sendMessage = async message => {
        const kind = (message as { kind?: string }).kind ?? '';
        if (kind.startsWith('known.capture.') || kind.startsWith('known.classification.')) (globalThis as unknown as { captureWrites: unknown[] }).captureWrites.push(message);
        return original(message);
      };
    });
    await mkdir(evidencePath, { recursive: true });
    for (const state of ['compact', 'expanded', 'pending']) {
      await page.goto(`chrome-extension://${id}/popup.html?preview=${state}`);
      await expect(page.locator('#capture-status')).toBeVisible();
      await expect(page.locator('#capture-status-text')).toContainText('Preview');
      await expect(page.locator('#popup-foot')).toHaveAttribute('data-mode', 'result');
      if (state === 'expanded') await expect(page.locator('#dest-panel')).toBeVisible();
      expect(await page.evaluate(() => (globalThis as unknown as { captureWrites: unknown[] }).captureWrites)).toEqual([]);
      await page.locator('body').screenshot({ path: resolve(evidencePath, `popup-preview-${state}.png`) });
    }
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.goto(`chrome-extension://${id}/popup.html?preview=compact`);
    await expect(page.locator('#capture-status')).toBeVisible();
    expect(await page.locator('#capture-progress > span').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    await page.locator('body').screenshot({ path: resolve(evidencePath, 'popup-preview-reduced-motion.png') });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('AC-06 validates a real action POPUP context and rejects a popup.html tab', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-lifecycle-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host, page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    // The popup re-navigates itself once to get a unique surface URL; evaluate after that, not during it.
    await page.waitForURL(/surface=/u);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.context' }))).toMatchObject({ ok: true, actionPopup: false });
    await page.goto('about:blank');
    await worker.evaluate(() => {
      chrome.runtime.onMessage.addListener((message, sender) => {
        if ((message as { kind?: string }).kind === 'known.capture.context') (globalThis as unknown as { captureSender: unknown }).captureSender = sender;
        return false;
      });
    });
    await worker.evaluate(() => { void chrome.action.openPopup(); });
    await expect.poll(async () => (await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }))).length).toBe(1);
    await expect.poll(async () => (await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] })))[0]?.documentUrl).toContain('surface=');
    const port = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string; webSocketDebuggerUrl: string }[];
    const popup = targets.find(target => target.url.startsWith(`chrome-extension://${id}/popup.html`));
    expect(popup).toBeDefined();
    const result = await cdp(popup!.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: "chrome.runtime.sendMessage({kind:'known.capture.context'})", awaitPromise: true, returnByValue: true,
    }) as { result: { value: unknown } };
    const senderEvidence = await worker.evaluate(async () => ({ sender: (globalThis as unknown as { captureSender: unknown }).captureSender,
      contexts: await chrome.runtime.getContexts({ contextTypes: ['POPUP'] }) }));
    expect(result.result.value, JSON.stringify(senderEvidence)).toMatchObject({ ok: true, actionPopup: true });
    const screenshot = await cdp(popup!.webSocketDebuggerUrl, 'Page.captureScreenshot', {}) as { data: string };
    await writeFile(resolve(evidencePath, 'popup-real-context.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp(popup!.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined);
    await expect.poll(async () => (await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }))).length).toBe(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

async function cdp(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== 1) return;
      clearTimeout(timer); socket.close(); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); });
  });
}
