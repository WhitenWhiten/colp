// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { formatSavedDate, paintCaptureAlert, paintFavicon, paintStatusLine, setFooterMode, urlSummary } from '../src/popup-shell.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

beforeEach(() => { document.body.replaceChildren(); mountPopupShell(); });

test('the status line shows its text and meta, and hides for undefined', () => {
  const host = byId('capture-status');
  paintStatusLine({ icon: 'check-circle', text: 'Saved', meta: 'On this browser' });
  expect(host.hidden).toBe(false);
  expect(byId('capture-status-text').textContent).toBe('Saved');
  expect(byId('capture-status-meta').textContent).toBe('On this browser');
  expect(host.dataset.tone).toBeUndefined();
  paintStatusLine({ icon: 'clock', text: 'Could not save', tone: 'danger' });
  expect(host.dataset.tone).toBe('danger');
  expect(byId('capture-status-meta').textContent).toBe('');
  paintStatusLine(undefined);
  expect(host.hidden).toBe(true);
});

test('the alert carries its tone and hides without text', () => {
  paintCaptureAlert('Offline', 'danger');
  expect(byId('capture-alert').hidden).toBe(false);
  expect(byId('capture-alert').dataset.tone).toBe('danger');
  expect(byId('capture-alert-text').textContent).toBe('Offline');
  paintCaptureAlert(undefined);
  expect(byId('capture-alert').hidden).toBe(true);
});

test('the footer records its mode for the stylesheet to pick the actions', () => {
  setFooterMode('manual');
  expect(byId('popup-foot').dataset.mode).toBe('manual');
  setFooterMode('result');
  expect(byId('popup-foot').dataset.mode).toBe('result');
  setFooterMode('existing');
  expect(byId('popup-foot').dataset.mode).toBe('existing');
});

test('the favicon falls back to the generic page icon unless it is an http image', () => {
  paintFavicon('https://example.org/icon.png');
  expect((byId('tab-favicon') as HTMLImageElement).getAttribute('src')).toBe('https://example.org/icon.png');
  expect(byId('tab-favicon').hidden).toBe(false);
  expect(byId('tab-fallback').hidden).toBe(true);
  paintFavicon('chrome://favicon/x');
  expect(byId('tab-favicon').hidden).toBe(true);
  expect(byId('tab-fallback').hidden).toBe(false);
  paintFavicon(undefined);
  expect(byId('tab-favicon').hasAttribute('src')).toBe(false);
});

test('url summary and saved date degrade to something readable', () => {
  expect(urlSummary('https://example.org/')).toBe('example.org');
  expect(urlSummary('https://example.org/a/b?q=1#x')).toBe('example.org/a/b');
  expect(urlSummary('not a url')).toBe('not a url');
  expect(formatSavedDate(undefined)).toBe('');
  expect(formatSavedDate(Date.UTC(2026, 0, 15, 12))).toMatch(/2026/u);
});
