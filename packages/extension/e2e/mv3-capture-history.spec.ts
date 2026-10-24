import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
test('AC-08 shows the frozen metric cohort, paginates 1000 local tasks and exports only redacted diagnostics', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-history-')), extension = resolve(import.meta.dirname, '../dist/production');
  const evidence = resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture');
  await mkdir(evidence, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'), page = await context.newPage();
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    // The statistics live in Help & diagnostics, behind the Saving statistics disclosure.
    const openStatistics = async () => { await page.locator('#saving-statistics > summary').click(); await expect(page.locator('.capture-summary-grid')).toBeVisible(); };
    await page.goto(`${origin}/options.html#help?category=capture`); await openStatistics();
    async function seed(start: number, end: number) {
      await page.evaluate(async ([start, end]) => {
        const config = await (await fetch(chrome.runtime.getURL('generated-config.json'))).json() as { serverOrigin: string };
        const stored = await chrome.storage.local.get(['known.auth.authority-generation.v1', 'known.capture.device.v1']);
        const generation = (stored['known.auth.authority-generation.v1'] as { generation?: number } | undefined)?.generation ?? 0;
        const scope = { serverOrigin: config.serverOrigin, accountId: null, authorityGeneration: generation, collectionId: null };
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('known-capture', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const tx = db.transaction('tasks', 'readwrite'), tasks = tx.objectStore('tasks'), now = Date.now();
        for (let i = start!; i < end!; i++) {
          const auto = i < 90, applied = i < 80, saved = i < 94 || i >= 100;
          tasks.put({ version: 1, captureId: crypto.randomUUID(), commandId: crypto.randomUUID(), batchId: null, scope,
            scopeKey: JSON.stringify([scope.serverOrigin, null, generation, null]), ownerKey: JSON.stringify([scope.serverOrigin, null]),
            source: 'manual-popup', tabId: null, url: `https://fixture.example/page-${i}?private=not-for-diagnostics`, title: `Fixture page ${i}`,
            targetNativeId: 'fixture', insertPosition: 'bottom', saveAnother: false, allowUnverifiedCloud: false,
            createdAt: now - i * 1000, updatedAt: now, revision: 1, policyVersion: 'fixture', automaticIntent: auto, disposition: 'new',
            save: saved ? 'local-saved' : i < 96 ? 'failed' : 'unknown', classification: applied ? 'applied' : auto ? 'waiting' : 'none',
            sync: saved ? 'confirmed' : 'local-only', existence: null, nativeIntentId: null, nativeId: null, nodeId: null,
            executionId: null, decisionId: applied ? crypto.randomUUID() : null,
            localLocation: null, cloudLocation: null, appliedRevision: applied ? 'fixture-revision' : null, manualFence: 0, controlGeneration: 0, reason: null,
            feedbackKind: i < 18 ? 'explicit_positive' : i < 24 ? 'explicit_negative' : i < 64 ? 'implicit_positive' : undefined,
            deviceId: stored['known.capture.device.v1'], savedAt: saved ? now - i * 1000 + 20 : undefined });
        }
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
      }, [start, end]);
    }
    await seed(0, 100); await page.reload(); await openStatistics();
    await expect(page.locator('.capture-summary-grid')).toContainText('94/100');
    await expect(page.locator('.capture-summary-grid')).toContainText('88.9% (80/90)');
    await expect(page.locator('.capture-summary-grid')).toContainText('75.0% (18/24)');
    await expect(page.locator('#capture-overview')).toContainText('30.0% (24/80)');
    await page.screenshot({ path: resolve(evidence, 'history-fixture-cohort.png'), fullPage: true });
    await seed(100, 1000); await page.goto(`${origin}/options.html#history`);
    await expect(page.locator('#capture-history')).toBeVisible();
    await expect(page.locator('.hist-row')).toHaveCount(50);
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const narrow = i % 2 === 0; await page.locator('#capture-history-search').fill(narrow ? 'Fixture page 99' : 'Fixture');
      const started = performance.now();
      await expect(page.locator('.hist-row')).toHaveCount(narrow ? 11 : 50); timings.push(performance.now() - started);
    }
    await page.screenshot({ path: resolve(evidence, 'history-fixture-filter.png'), fullPage: true });
    await page.goto(`${origin}/options.html#help?category=capture`);
    await expect(page.locator('[data-capture-view=diagnostics] pre')).toBeAttached();
    await expect.poll(() => page.locator('[data-capture-view=diagnostics] pre').textContent()).toContain('checkedAt');
    const diagnostic = await page.locator('[data-capture-view=diagnostics] pre').textContent();
    expect(diagnostic).not.toContain('fixture.example'); expect(diagnostic).not.toContain('Fixture page'); expect(diagnostic).not.toContain('private=');
    const sorted = [...timings].sort((a, b) => a - b);
    await writeFile(resolve(evidence, 'history-performance.json'), JSON.stringify({ fixture: true, records: 1000, initialRows: 50,
      browser: await context.browser()?.version(), headless: false, viewport: page.viewportSize(), warm: true,
      measurement: 'Playwright click to rendered filtered page, including automation overhead', samplesMs: timings,
      p50Ms: sorted[2], p95Ms: sorted[4], bundleSha256: createHash('sha256').update(await readFile(resolve(extension, 'options.js'))).digest('hex') }, null, 2));
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
