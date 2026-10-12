import { cpus, totalmem } from 'node:os';
import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { KNOW_N_BACKEND_ONLY, knowNBackendRoot } from './cloud-product-fixtures.js';
import { openExtensionOptions, signInExtension } from './extension-auth.js';
import { grantBookmarks, confirmFirstRun, waitFirstRunProductQuiet, wakeEngine } from './kns-08-harness.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { capturePopupTarget, pressNativePopupKey } from './capture-popup-cdp.js';
import type { CaptureTask } from '../src/capture/contracts.js';
// Capture, classification, credits and the favicon helper are Know-N backend routes.
test.skip(!knowNBackendRoot, KNOW_N_BACKEND_ONLY);

test('AC-11 real MV3 and PostgreSQL preserve save, apply, feedback and clear receipts with a synthetic provider', async () => {
  test.setTimeout(360000);
  const stack = await startRealStack({ classification: true, syntheticCapture: true });
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-real-')), extension = resolve(import.meta.dirname, '../dist/production');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false, ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--remote-debugging-port=0', '--no-proxy-server', '--ignore-certificate-errors',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=${stack.browserHostResolverRules}`] });
  try {
    const { page } = await openExtensionOptions(context); await signInExtension(page); await grantBookmarks(page);
    await stack.classificationProduct!.fundClassification(FIXTURE_COLLECTION_ID); stack.classificationProduct!.setProviderAvailable();
    const root = await page.evaluate(async () => {
      const root = await chrome.bookmarks.create({ title: 'Capture real stack' });
      const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Software development' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'Reference', url: 'https://example.org/reference' }); return root;
    });
    await confirmFirstRun(page, [root.title]);
    const binding = await page.evaluate(async () => (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']) as typeof stack.extensionBinding;
    await waitFirstRunProductQuiet(page, stack, binding);
    // Capture settings live on the Saving page; the folder and saves it governs are summarised on History.
    await page.locator('#nav-saving').click();
    await expect(page.locator('#pref-capture')).toBeVisible();
    await page.getByRole('radio', { name: /^Automatic/ }).check(); await page.getByRole('button', { name: 'Save automatic mode' }).click();
    await page.locator('[data-capture-default-target]').getByRole('button', { name: 'Change' }).click(); await page.getByLabel('Default folder on this browser').selectOption(root.id);
    await page.getByRole('button', { name: 'Save this browser’s settings' }).click();
    // Leaving the page before the save is confirmed would keep the settings block's old state.
    await expect(page.locator('[data-capture-default-target]')).toContainText(root.title);
    // The status summary lives on History; the spending limit is on AI suggestions.
    await page.locator('#nav-history').click();
    await expect(page.locator('[data-capture-controls]')).toContainText(root.title);
    await page.locator('#nav-ai').click();
    await page.locator('[data-capture-authorization]').getByRole('button', { name: /^(Set limit|Change)$/u }).click();
    await page.getByLabel('Maximum credits in 24 hours').fill('10'); await page.getByRole('button', { name: 'Save this browser’s settings' }).click();
    await expect(page.locator('[data-capture-authorization]')).toContainText('per day');
    await page.locator('#nav-saving').click();
    await page.locator('#capture-panel-duration').selectOption('0');
    const url = 'https://example.org/capture-real?q=kept#fragment';
    const tab = await context.newPage(); await tab.route(url.split('#')[0]!, route => route.fulfill({ contentType: 'text/html', body: '<title>Capture real webpage</title>' })); await tab.goto(url); await expect(tab).toHaveTitle('Capture real webpage'); await tab.bringToFront();
    const popup = await capturePopupTarget(context, profile, tab);
    await popup.evaluate(`(() => {
      const data = { attachedAt: Date.now(), firstSavedAt: null, firstCompleteAt: null, frames: [], longTasks: [] };
      globalThis.capturePerformance = data;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) data.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true });
      let previous;
      const frame = time => { if (previous !== undefined) data.frames.push(time - previous); previous = time;
        if (document.querySelector('#capture-status-text')?.textContent === 'Saved' && data.firstSavedAt === null) data.firstSavedAt = Date.now();
        if (document.body.dataset.complete === 'true' && data.firstCompleteAt === null) data.firstCompleteAt = Date.now();
        if (!data.firstCompleteAt || Date.now() - data.firstCompleteAt < 500) requestAnimationFrame(frame);
      }; requestAnimationFrame(frame);
    })()`);
    await expect.poll(async () => popup.evaluate<string>("document.querySelector('#capture-status-text')?.textContent ?? ''"), { timeout: 30000 }).toContain('Saved');
    const latest = async () => (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as { tasks: CaptureTask[] }).tasks.find(task => task.url === url)!;
    await expect.poll(async () => { await wakeEngine(page); const task = await latest();
      if (task) await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.resume', captureId }), task.captureId);
      return (await latest())?.classification; }, { timeout: 60000 }).toBe('applied');
    const task = await latest();
    await expect.poll(async () => { await wakeEngine(page); return (await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId }), task.captureId) as { task?: CaptureTask }).task?.sync; }, { timeout: 60000 }).toBe('confirmed');
    // The pill follows the AI's move (not the whole panel's text, which also holds hidden rows), and the
    // bookmark-permission alert is not showing: the permission is granted.
    await expect.poll(() => popup.evaluate<string>("document.getElementById('dest-folder')?.textContent ?? ''")).toBe('Software development');
    expect(await popup.evaluate<boolean>("document.getElementById('permission-note')?.hidden ?? false")).toBe(true);
    expect(await page.evaluate(({captureId,nodeRevision}) => chrome.runtime.sendMessage({kind:'known.capture.feedback',captureId,nodeRevision,eventId:crypto.randomUUID(),feedback:'implicit_positive'}), {captureId:task.captureId,nodeRevision:task.appliedRevision!})).toMatchObject({ok:false});
    await expect.poll(() => popup.evaluate<boolean>("Boolean(globalThis.capturePerformance?.firstCompleteAt && Date.now()-globalThis.capturePerformance.firstCompleteAt>=500)")).toBe(true);
    const timing = await popup.evaluate<{ attachedAt: number; firstSavedAt: number; firstCompleteAt: number; frames: number[]; longTasks: number[] }>('globalThis.capturePerformance');
    const sortedFrames = [...timing.frames].sort((a,b)=>a-b);
    await mkdir(resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture'), { recursive: true });
    await writeFile(resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/popup-performance.json'), JSON.stringify({
      browser: await context.browser()?.version(), node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryGiB: Math.round(totalmem()/1024**3),
      syntheticProvider: true, coldPopup: true, openedToObserverMs: timing.attachedAt-popup.openedAt,
      openedToSavedObservedMs: timing.firstSavedAt-popup.openedAt, nativeReceiptToSavedObservedMs: task.savedAt ? timing.firstSavedAt-task.savedAt : null,
      frameSamples: timing.frames.length, frameP50Ms: sortedFrames[Math.floor(sortedFrames.length*.5)], frameP95Ms: sortedFrames[Math.floor(sortedFrames.length*.95)],
      longTaskDurationsMs: timing.longTasks, limitations: 'Observer attaches after CDP discovers the real popup. Opening and receipt latencies are observed upper bounds including automation overhead, not isolated first-feedback timings. Frames cover pending work through 500ms after confirmed presentation.' }, null, 2));
    // Real POPUP presentation, followed by explicit rating. DOM click is a test interaction; production still checks the POPUP sender.
    await popup.evaluate("document.getElementById('capture-done')?.click()");
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => (await stack.classificationProduct!.capture.facts()).events.map(event => event.kind), { timeout: 15000 }).toContain('explicit_positive');
    const before = await stack.classificationProduct!.capture.facts(); expect(before.decisions.filter(value => value.capture_id === task.captureId)).toHaveLength(1);
    expect(before.charges).toHaveLength(1);
    const calls = stack.classificationProduct!.providerCallCount();
    await page.goto(`chrome-extension://${new URL(page.url()).host}/options.html#history?task=${task.captureId}`);
    await expect(page.getByRole('heading', { name: 'Capture real webpage' })).toBeVisible();
    await page.getByRole('button', { name: 'Withdraw rating', exact: true }).click();
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => (await stack.classificationProduct!.capture.facts()).events.map(event => event.kind)).toContain('withdrawn');
    // The detail's folder is a labelled pill ("Folder: <path>") that opens a listbox of folders; tags and note sit below it.
    // The detail repaints when the withdrawal lands; reopen it so the picker we use is the settled one.
    await page.reload(); await expect(page.getByRole('heading', { name: 'Capture real webpage' })).toBeVisible();
    await page.getByRole('button', { name: /^Folder: / }).click();
    await page.getByRole('listbox', { name: 'Folder', exact: true }).locator(`[data-folder-id="${root.id}"]`).click();
    await page.getByLabel('Tags', { exact: true }).fill('User correction');
    // Leaving the save and coming back keeps the unsaved edits.
    await page.evaluate(() => { location.hash = 'history'; }); await page.goBack();
    await expect(page.getByLabel('Tags', { exact: true })).toHaveValue('User correction');
    await expect(page.getByRole('button', { name: /^Folder: / })).toHaveAttribute('data-value', root.id);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.detail-fields [role=status]')).toContainText('Saved.');
    await expect.poll(async () => { await wakeEngine(page); return (await page.evaluate(id => chrome.bookmarks.get(id), task.nativeId!))[0]?.parentId; }, { timeout: 30000 }).toBe(root.id);
    expect((await stack.classificationProduct!.capture.facts()).events.map(event => event.kind)).toContain('correction_applied');
    await page.getByRole('button', { name: 'Back to History', exact: true }).click();
    // Correction memory lives on AI suggestions.
    await page.locator('#nav-ai').click();
    await page.locator('[data-capture-learning]').getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('button', { name: 'Clear memory', exact: true }).click();
    await expect(page.locator('[data-capture-learning]')).toContainText('Memory last cleared');
    expect(stack.classificationProduct!.providerCallCount()).toBe(calls);
    expect((await page.evaluate(id => chrome.bookmarks.get(id), task.nativeId!))[0]?.url).toBe(url);
    await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/real-stack-memory-cleared.png'), fullPage: true });

    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', resultPanelAutoDismissMs: 3000, userGesture: true }));
    const timedUrl = 'https://example.org/capture-timed';
    await tab.route(timedUrl, route => route.fulfill({ contentType: 'text/html', body: '<title>Timed capture webpage</title>' }));
    await tab.goto(timedUrl); await tab.bringToFront();
    const timedPopup = await capturePopupTarget(context, profile, tab);
    await timedPopup.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    const find = async (url: string) => (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as { tasks: CaptureTask[] }).tasks.find(task => task.url === url);
    await expect.poll(async () => {
      await wakeEngine(page); const pending = await find(timedUrl);
      if (pending) await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.resume', captureId }), pending.captureId);
      return (await find(timedUrl))?.classification;
    }, { timeout: 60000 }).toBe('applied');
    await expect.poll(async () => { await wakeEngine(page); const pending = await find(timedUrl);
      return pending && (await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId }), pending.captureId) as { task?: CaptureTask }).task?.sync;
    }, { timeout: 20000 }).toBe('confirmed');
    const presentation = await timedPopup.evaluate("({focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.outerHTML,hover:document.querySelector('.pp')?.matches(':hover'),complete:document.body.dataset.complete,text:document.querySelector('#capture')?.textContent})");
    await expect.poll(async () => (await stack.classificationProduct!.capture.facts()).events.filter(event => event.kind === 'implicit_positive').length, { timeout: 10000, message: JSON.stringify(presentation) }).toBe(1);
    await expect.poll(() => context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).then(value => value.length))).toBe(0);
    expect((await stack.classificationProduct!.capture.facts()).events.find(event => event.kind === 'implicit_positive')?.learning_eligible).toBe(false);
    const blurUrl = 'https://example.org/capture-blurred';
    await tab.route(blurUrl, route => route.fulfill({ contentType: 'text/html', body: '<title>Blurred capture webpage</title>' }));
    await tab.goto(blurUrl); await tab.bringToFront(); await capturePopupTarget(context, profile, tab);
    await expect.poll(async () => (await find(blurUrl))?.save).toBe('local-saved');
    await tab.bringToFront();
    await expect.poll(() => context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).then(value => value.length))).toBe(0);
    await expect.poll(async () => { await wakeEngine(page); const pending = await find(blurUrl);
      if (pending) await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.resume', captureId }), pending.captureId);
      return (await find(blurUrl))?.classification; }, { timeout: 60000 }).toBe('applied');
    expect((await stack.classificationProduct!.capture.facts()).events.filter(event => event.kind === 'implicit_positive')).toHaveLength(1);
    const beforeExisting = stack.classificationProduct!.providerCallCount();
    const existing = await capturePopupTarget(context, profile, tab);
    await expect.poll(() => existing.evaluate<string>("document.querySelector('#capture-status-text')?.textContent ?? ''")).toBe('Already saved');
    await pressNativePopupKey('Escape');
    await expect.poll(() => context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).then(value => value.length))).toBe(0);
    expect(stack.classificationProduct!.providerCallCount()).toBe(beforeExisting);
    expect((await page.evaluate(url => chrome.bookmarks.search({ url }), blurUrl))).toHaveLength(1);

    const controls = async () => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.control' })) as Promise<import('../src/capture/runtime-control.js').CaptureRuntimeView>;
    const change = async (action: 'pause' | 'resume') => {
      const current = await controls();
      expect(await page.evaluate(input => chrome.runtime.sendMessage(input), { kind: 'known.capture.control.change', action,
        commandId: crypto.randomUUID(), generation: current.control.generation, scopeKey: current.scopeKey })).toMatchObject({ ok: true });
    };
    await change('pause'); const queueUrl = 'https://example.org/capture-paused-queue';
    const open = async (url: string, title: string) => {
      await tab.route(url, route => route.fulfill({ contentType: 'text/html', body: `<title>${title}</title>` }));
      await tab.goto(url); await tab.bringToFront(); return capturePopupTarget(context, profile, tab);
    };
    await open(queueUrl, 'Paused queue capture');
    await expect.poll(async () => (await find(queueUrl))?.save).toBe('local-saved');
    expect(stack.classificationProduct!.providerCallCount()).toBe(beforeExisting);
    await pressNativePopupKey('Escape');
    stack.classificationProduct!.holdNextProvider(); await change('resume');
    await expect.poll(async () => { await wakeEngine(page); const pending = await find(queueUrl);
      if (pending) void page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.resume', captureId }), pending.captureId);
      return stack.classificationProduct!.providerHeld(); }, { timeout: 30000 }).toBe(true);
    await change('pause'); stack.classificationProduct!.releaseProvider();
    await expect.poll(async () => (await find(queueUrl))?.classification, { timeout: 15000 }).toBe('manual');
    const queued = (await find(queueUrl))!;
    expect((await page.evaluate(id => chrome.bookmarks.get(id), queued.nativeId!))[0]?.parentId).toBe(root.id);
    const beforeExplicit = stack.classificationProduct!.providerCallCount(); await change('resume');
    expect((await find(queueUrl))?.classification).toBe('manual');
    expect((await page.evaluate(id => chrome.bookmarks.get(id), queued.nativeId!))[0]?.parentId).toBe(root.id);
    expect(await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.apply', captureId, commandId: crypto.randomUUID(), userGesture: true }), queued.captureId)).toMatchObject({ ok: true });
    expect(stack.classificationProduct!.providerCallCount()).toBe(beforeExplicit);
    expect((await find(queueUrl))?.automatic?.decision?.automaticApplied).toBe(false);
    const applyUrl = 'https://example.org/capture-submitted-apply';
    stack.classificationProduct!.holdNextCaptureApply(); await open(applyUrl, 'Submitted apply capture');
    await expect.poll(async () => { await wakeEngine(page); const pending = await find(applyUrl);
      if (pending) void page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.resume', captureId }), pending.captureId);
      return stack.classificationProduct!.captureApplyHeld(); }, { timeout: 30000 }).toBe(true);
    await change('pause'); const submitted = (await find(applyUrl))!; expect(submitted.automatic?.applySubmitted).toBe(true);
    stack.classificationProduct!.releaseCaptureApply();
    await expect.poll(async () => (await find(applyUrl))?.classification).toBe('applied');
    const beforeCheck = stack.classificationProduct!.providerCallCount();
    await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.decision.check', captureId }), submitted.captureId);
    expect(stack.classificationProduct!.providerCallCount()).toBe(beforeCheck);
    await pressNativePopupKey('Escape'); await change('resume');
    await stack.classificationProduct!.expireAllCredits(FIXTURE_COLLECTION_ID);
    const noCreditsUrl = 'https://example.org/capture-no-credits'; await open(noCreditsUrl, 'Saved without classification credits');
    await expect.poll(async () => { await wakeEngine(page); const pending = await find(noCreditsUrl);
      if (pending) await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.resume', captureId }), pending.captureId);
      return (await find(noCreditsUrl))?.classification; }, { timeout: 30000 }).toBe('manual');
    expect((await find(noCreditsUrl))?.save).toBe('local-saved'); expect(stack.classificationProduct!.providerCallCount()).toBe(beforeCheck);
    await pressNativePopupKey('Escape');

    await page.bringToFront(); await page.locator('#nav-saving').click();
    await expect(page.locator('#pref-capture')).toBeVisible();
    await context.setOffline(true); await page.locator('#capture-panel-duration').selectOption('5000');
    await expect(page.locator('#bookmark-preferences-status')).toContainText('Saved on this browser');
    await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/settings-pending.png'), fullPage: true });
    await context.setOffline(false);
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' }));
    const remoteChange = await page.evaluate(async () => {
      const session = await (await fetch('https://known.example/api/v1/session', { credentials: 'include' })).json() as { csrfToken: string };
      const response = await fetch('https://known.example/api/v1/me/bookmark-preferences', { credentials: 'include' });
      return (await fetch('https://known.example/api/v1/me/bookmark-preferences', { method: 'PATCH', credentials: 'include', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken,
        'Known-Command-Id': crypto.randomUUID(), 'If-Match': response.headers.get('etag')!,
      }, body: JSON.stringify({ resultPanelAutoDismissMs: 10000 }) })).status;
    });
    expect(remoteChange).toBe(200);
    await page.locator('#capture-resume-online').uncheck();
    await expect(page.locator('#bookmark-preferences-conflict-values')).toContainText('This browser:');
    await expect(page.locator('#bookmark-preferences-conflict-values')).toContainText('Account:');
    await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/settings-conflict.png'), fullPage: true });
    await page.getByRole('button', { name: 'Use server values', exact: true }).click();
    await expect(page.locator('#capture-panel-duration')).toHaveValue('10000');
    const facts = await stack.classificationProduct!.capture.facts();
    await writeFile(resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/real-stack-capture.json'), JSON.stringify({ syntheticProvider: true,
      productionQualityGateApproved: false, decisions: facts.decisions.length, charges: facts.charges.map(value => value.state), events: facts.events,
      providerCalls: stack.classificationProduct!.providerCallCount(), lifecycle: ['real Alt+S', 'manual close duration', '3-second implicit acceptance', 'blur without implicit acceptance', 'existing capture without duplicate', 'native Escape closes popup', 'pause before execution', 'pause during provider', 'resume requires explicit application', 'pause after submitted apply', 'insufficient credits preserves native save'], nativeBookmarkPreserved: true, browser: await context.browser()?.version() }, null, 2));
  } finally { stack.classificationProduct!.releaseProvider(); stack.classificationProduct!.releaseCaptureApply(); await context.close(); await rm(profile, { recursive: true, force: true }); await stack.close(); }
});
