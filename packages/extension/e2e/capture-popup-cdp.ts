import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function capturePopupTarget(context: BrowserContext, profile: string, activePage?: Page) {
  const openedAt = Date.now();
  const worker = context.serviceWorkers()[0]!;
  if (activePage && process.platform === 'linux') {
    await activePage.bringToFront(); const title = await activePage.title(), run = promisify(execFile);
    const windows = await run('xdotool', ['search', '--name', title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')]);
    const id = windows.stdout.trim().split('\n').at(-1)!;
    await run('xdotool', ['windowfocus', '--sync', id]); await run('xdotool', ['key', 'alt+s']);
  } else await worker.evaluate(() => { void chrome.action.openPopup(); });
  const port = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  let target: { url: string; webSocketDebuggerUrl: string } | undefined;
  await expect.poll(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string; webSocketDebuggerUrl: string }[];
    target = targets.find(value => value.url.includes('/popup.html?surface=')); return Boolean(target);
  }).toBe(true);
  return { openedAt, evaluate: async <T>(expression: string): Promise<T> => {
    const result = await popupCdp(target!.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as { result: { value: T }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  }, send: (method: string, params: Record<string, unknown>) => popupCdp(target!.webSocketDebuggerUrl, method, params) };
}
export async function popupCdp(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url), timer = setTimeout(() => { socket.close(); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== 1) return; clearTimeout(timer); socket.close(); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); });
  });
}

export async function pressNativePopupKey(key: string) { await promisify(execFile)('xdotool', ['key', key]); }
