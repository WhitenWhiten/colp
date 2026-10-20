import { expect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function grantOptionalBookmarks(page: Page, buttonName: string | Locator, titlePrefix: string, permission:{permissions?:string[];origins?:string[]}={permissions:['bookmarks']},beforeAttempt?:()=>Promise<void>) {
  const originalTitle = await page.title();
  try {
    if (process.platform === 'linux') await requireXdotool();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await beforeAttempt?.();
      const activationTitle = `${titlePrefix} ${Date.now()} ${attempt}`;
      await page.evaluate((title) => { document.title = title; }, activationTitle);
      const windows = process.platform === 'linux' ? await permissionWindowsX11(page, activationTitle) : [];
      const button = typeof buttonName === 'string' ? page.getByRole('button', { name: buttonName, exact: true }) : buttonName;
      const click = button.click({ timeout: 15_000 });
      const permissionInteraction = process.platform === 'win32'
        ? allowWindowsPermission(activationTitle)
        : process.platform === 'linux'
          ? grantBookmarksPermissionX11(page, windows, attempt)
          : pressPermissionKeys(page, attempt);
      const [clicked, interaction] = await Promise.allSettled([click, permissionInteraction]);
      if (clicked.status === 'rejected') throw clicked.reason;
      const granted = await readOptionalPermissionAfterReload(page, permission);
      // Chromium can remember prior consent and grant immediately, reloading the options
      // page before an X11 permission bubble appears. The actual permission is authoritative.
      if (interaction.status === 'rejected' && !granted) throw interaction.reason;
      if (granted) {
        await expect.poll(async () => {
          try {
            return Boolean(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' })));
          } catch {
            return false;
          }
        }, { timeout: 10_000 }).toBe(true);
        return;
      }
    }
    throw new Error('bookmarks_permission_denied');
  } finally {
    // Restoring the temporary X11 title must not replace an assertion failure
    // when permission grant itself has reloaded or closed the old document.
    await page.evaluate((title) => { document.title = title; }, originalTitle).catch(() => undefined);
  }
}

export async function readOptionalPermissionAfterReload(page: Pick<Page, 'evaluate' | 'isClosed'>,
  permission: { permissions?: string[]; origins?: string[] }): Promise<boolean> {
  let granted = false;
  await expect.poll(async () => {
    try { granted = await page.evaluate(value => chrome.permissions.contains(value), permission); return 'read'; }
    catch (error) {
      if (!page.isClosed() && error instanceof Error
        && /Execution context was destroyed|Cannot find context with specified id/u.test(error.message)) return 'reloading';
      throw error;
    }
  }, { timeout: 10_000, message: 'permission state unavailable after options reload' }).toBe('read');
  return granted;
}

async function permissionWindowsX11(page: Page, activationTitle: string): Promise<string[]> {
  await page.bringToFront();
  const escaped = activationTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  let ids: string[] = [];
  await expect.poll(async () => {
    // Initial rendering can replace the document title. Resolve the native
    // window before clicking: the permission flow may navigate or retitle it.
    await page.evaluate((title) => { document.title = title; }, activationTitle);
    try {
      const windows = await execFileAsync('xdotool', ['search', '--name', `.*${escaped}.*`], { timeout: 3_000 });
      ids = windows.stdout.trim().split(/\r?\n/u).filter(Boolean);
    } catch { ids = []; }
    return ids.length;
  }, { timeout: 10_000, message: 'bookmarks_permission_window_missing' }).toBeGreaterThan(0);
  return ids;
}

async function grantBookmarksPermissionX11(
  page: Page,
  ids: readonly string[],
  attempt: number,
): Promise<void> {
  // The Chromium extension-permission bubble only accepts keyboard input when its browser
  // window holds X focus; CDP key events do not reach it on every Linux configuration.
  // Raise the tab, activate the window resolved before the click, then focus the
  // bubble's Allow button (Tab) and accept it (Return).
  try {
    await page.bringToFront();
    // Let the permission bubble appear before steering keyboard focus to it.
    await new Promise((resolve) => setTimeout(resolve, 900));
    for (const id of ids) {
      // windowfocus uses XSetInputFocus directly, so it works without a window manager.
      await execFileAsync('xdotool', ['windowfocus', '--sync', id], { timeout: 3_000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const key of permissionKeys(attempt)) {
      await execFileAsync('xdotool', ['key', key], { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (error) {
    throw new Error('bookmarks_permission_x11_failed', { cause: error });
  }
}

async function requireXdotool(): Promise<void> {
  try { await execFileAsync('xdotool', ['--version'], { timeout: 3_000 }); }
  catch (error) { throw new Error('bookmarks_permission_xdotool_missing', { cause: error }); }
}

function permissionKeys(attempt: number): readonly string[] {
  if (attempt === 0) return ['Return'];
  if (attempt === 1) return ['Tab', 'Return'];
  return ['shift+Tab', 'Return'];
}

async function pressPermissionKeys(page: Page, attempt: number): Promise<void> {
  for (const key of permissionKeys(attempt)) {
    await page.keyboard.press(key === 'Return' ? 'Enter' : key === 'shift+Tab' ? 'Shift+Tab' : key);
  }
}

async function allowWindowsPermission(activationTitle: string) {
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$shell = New-Object -ComObject WScript.Shell; if (-not $shell.AppActivate('${activationTitle}')) { exit 41 }; `
    + 'Add-Type -AssemblyName UIAutomationClient; Start-Sleep -Milliseconds 250; '
    + '$root=[System.Windows.Automation.AutomationElement]::RootElement; $button=$null; '
    + 'foreach($name in @("Allow","允许")){ $nameCondition=New-Object System.Windows.Automation.PropertyCondition('
    + '[System.Windows.Automation.AutomationElement]::NameProperty,$name); '
    + '$typeCondition=New-Object System.Windows.Automation.PropertyCondition('
    + '[System.Windows.Automation.AutomationElement]::ControlTypeProperty,'
    + '[System.Windows.Automation.ControlType]::Button); $conditions=[System.Windows.Automation.Condition[]]@('
    + '$nameCondition,$typeCondition); $condition=New-Object System.Windows.Automation.AndCondition(,$conditions); '
    + '$button=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition); if($button){break} }; '
    + 'if($button){ $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } '
    + 'else { Add-Type -AssemblyName System.Windows.Forms; '
    + '[System.Windows.Forms.SendKeys]::SendWait("{TAB}{ENTER}") }']);
}
