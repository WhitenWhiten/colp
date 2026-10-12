import { t } from './i18n.js';
import { createIcon } from './icons.js';

/** One optional feature reports its own startup failure without interrupting the rest of the page. */
export function initializeSettingsSection(id: string, initialize: (host: HTMLElement) => unknown): void {
  const host = document.getElementById(id); if (!host) return;
  const report = (error: unknown) => {
    host.dataset.initialization = 'failed';
    for (const control of Array.from(host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button'))) control.disabled = true;
    const feedback = document.createElement('div'); feedback.className = 'inline-alert'; feedback.dataset.tone = 'danger'; feedback.setAttribute('role', 'alert');
    feedback.dataset.settingsInitError = '';
    const message = document.createElement('p'); message.textContent = t('settings_startFailed', 'This section could not load. Reload this page to try again.');
    const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn btn-ghost btn-sm';
    reload.textContent = t('common_reloadPage', 'Reload page'); reload.addEventListener('click', () => location.reload());
    feedback.append(createIcon('alert'), message, reload); host.append(feedback);
    // Section and exception category are enough to identify startup faults without logging user data.
    console.warn('Settings initialization failed', { section: id, errorType: error instanceof Error ? error.name : 'unknown' });
  };
  try { void Promise.resolve(initialize(host)).catch(report); }
  catch (error) { report(error); }
}
