// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { creditSummary, formatChange, shortDate } from '../src/credits-ledger.js';
import { bindSelectPills, paintSelectPills } from '../src/select-pill.js';
import { bindBookmarkPreferences } from '../src/bookmark-preferences-ui.js';
import { onSwitch, setSwitch, switchOn } from '../src/toggle-switch.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('settings switches', () => {
  test('state lives in aria-checked and a click flips it unless the switch is disabled', () => {
    document.body.innerHTML = '<button id="s" class="toggle" type="button" role="switch" aria-checked="false"></button>';
    const control = document.getElementById('s') as HTMLButtonElement, seen: boolean[] = [];
    onSwitch(control, (on) => seen.push(on));
    control.click();
    expect(switchOn(control)).toBe(true);
    control.disabled = true; control.click();
    expect(switchOn(control)).toBe(true);
    control.disabled = false; control.click();
    expect(seen).toEqual([true, false]);
    setSwitch(control, true);
    expect(control.getAttribute('aria-checked')).toBe('true');
  });
});

describe('toolbar select pills', () => {
  test('the visible value follows the wrapped select', () => {
    document.body.innerHTML = '<div><label class="select-pill"><span>Type: </span><strong data-pill-value></strong>'
      + '<select><option value="a">All</option><option value="b" selected>Spend</option></select></label></div>';
    const select = document.querySelector('select')!, value = document.querySelector('[data-pill-value]')!;
    bindSelectPills();
    expect(value.textContent).toBe('Spend');
    select.selectedIndex = 0; select.dispatchEvent(new Event('change'));
    expect(value.textContent).toBe('All');
    select.selectedIndex = 1; paintSelectPills();
    expect(value.textContent).toBe('Spend');
  });
});

describe('credits summary', () => {
  test('says how many credits are available and only mentions what needs saying', () => {
    expect(creditSummary({ available: 12480, reserved: 0, expiringPoints: 0, nextExpiryAt: null })).toEqual({ title: '12,480 available', hint: '' });
    const hint = creditSummary({ available: 5, reserved: 320, expiringPoints: 240, nextExpiryAt: '2099-10-13T00:00:00Z' }).hint;
    expect(hint).toMatch(/^320 on hold · 240 expire on /u);
    expect(creditSummary(undefined).title).toBe('Balance unavailable');
  });

  test('changes carry a sign and zero reads as a dash; unreadable dates stay as they were', () => {
    expect(formatChange(1200)).toBe('+1,200');
    expect(formatChange(-3)).toBe('−3');
    expect(formatChange(0)).toBe('–');
    expect(shortDate('not a date')).toBe('not a date');
  });
});

describe('preference conflict notice', () => {
  test('names both sides the way the settings do, never as stored codes', async () => {
    document.body.innerHTML = '<div id="bookmark-preferences-notice" hidden><p id="bookmark-preferences-status"></p><dl id="bookmark-preferences-conflict-values" hidden></dl>'
      + '<button id="bookmark-preferences-use-server" hidden></button><button id="bookmark-preferences-use-local" hidden></button></div>'
      + '<button id="bookmark-insert-top" data-value="top"></button><button id="bookmark-insert-bottom" data-value="bottom"></button>'
      + '<button id="bookmark-folders-first" role="switch" aria-checked="false"></button>';
    const preferences = { bookmarkInsertPosition: 'bottom', foldersFirst: true };
    vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ok: true, preferences, scope: 'account', source: 'server', revision: '1', etag: '"1"',
      pending: false, conflict: true, conflictValues: { local: preferences, remote: { bookmarkInsertPosition: 'top', foldersFirst: false } } }) } });
    try {
      await bindBookmarkPreferences().refresh();
      const notice = document.getElementById('bookmark-preferences-notice')!;
      expect(notice.hidden).toBe(false);
      const text = document.getElementById('bookmark-preferences-conflict-values')!.textContent!;
      expect(text).toContain('This browser: Bottom of folder / Account: Top of folder');
      expect(text).toContain('This browser: On / Account: Off');
      expect(text).not.toMatch(/\btrue\b|\bfalse\b|\bbottom\b/u);
    } finally { vi.unstubAllGlobals(); }
  });
});
