import { createIcon } from '../icons.js';
import { button, el, searchCompact, selectOf, selectPill } from '../library-dom.js';
import { t } from '../i18n.js';

const STATUS: readonly string[] = ['all', 'attention', 'progress', 'completed'];

/**
 * History's filters in the kit's toolbar grammar: a search field and "Label:
 * value" pills, with the rarely changed filters behind "More filters". Every
 * control applies as soon as it changes; there is no Apply button.
 */
export function createHistoryToolbar(zoneValue: string) {
  const days = selectOf([['7', t('common_n7Days', '7 days')], ['30', t('common_n30Days', '30 days')], ['90', t('common_n90Days', '90 days')]], '7');
  const filter = selectOf([['all', t('common_all', 'All')], ['attention', t('common_needsAttention', 'Needs attention')], ['progress', t('common_inProgress', 'In progress')], ['completed', t('common_completed', 'Completed')]], 'all');
  const scope = selectOf([['local', t('common_thisBrowser', 'This browser')], ['cloud', t('capture_allCloudDevices', 'All cloud devices')]], 'local');
  const source = selectOf([['', t('common_allSources', 'All sources')], ['action-popup', t('common_toolbar', 'Toolbar')], ['manual-popup', t('common_manualPopup', 'Manual popup')], ['context-page', t('common_pageMenu', 'Page menu')],
    ['context-link', t('common_linkMenu', 'Link menu')], ['batch', t('common_tabBatch', 'Tab batch')]], '');
  const zone = selectOf([...new Set([zoneValue, 'UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London'])].map((value) => [value, value] as const), zoneValue);

  const search = searchCompact(t('capture_titleDomain', 'Title or domain'), t('capture_searchTitlesDomains', 'Search titles and domains'));
  search.input.name = 'q'; search.input.id = 'capture-history-search';
  const devicesPill = selectPill(t('common_devices', 'Devices'), scope); devicesPill.hidden = true;
  const select = button(t('manager_select', 'Select'), 'btn btn-ghost btn-sm'); select.setAttribute('aria-pressed', 'false');
  const moreToggle = button('', 'btn btn-ghost btn-sm'); moreToggle.setAttribute('aria-expanded', 'false');
  moreToggle.append(t('common_moreFilters', 'More filters'), createIcon('chevron-down', 12));
  const bar = el('div', undefined, 'toolbar hist-toolbar');
  const grow = el('span', undefined, 'toolbar-grow');
  bar.append(search.field, selectPill(t('common_status', 'Status'), filter), selectPill(t('common_period', 'Period'), days), moreToggle, grow, select);

  const clear = button(t('common_clearFilters', 'Clear filters'), 'btn btn-ghost btn-sm');
  const more = el('div', undefined, 'toolbar hist-more'); more.hidden = true;
  more.append(devicesPill, selectPill(t('common_source', 'Source'), source), selectPill(t('common_timezone', 'Timezone'), zone), clear);
  moreToggle.addEventListener('click', () => setMore(more.hidden));
  function setMore(open: boolean): void { more.hidden = !open; moreToggle.setAttribute('aria-expanded', String(open)); moreToggle.dataset.open = String(open); }

  const element = el('div', undefined, 'hist-filters'); element.append(bar, more);
  return { element, query: search.input, days, filter, scope, source, zone, select, clear, devicesPill, setMore, isStatus: (value: string) => STATUS.includes(value) };
}
