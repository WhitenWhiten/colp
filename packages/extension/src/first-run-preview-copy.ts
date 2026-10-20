import { metadataCounts, metadataCountsCopy } from './metadata-transfer.js';
import { firstRunTotalsCopy } from './first-run-draft.js';
import { ingressDiagnosticLabel } from './ingress-diagnostics-ui.js';
import { t, tn } from './i18n.js';

export function previewOmissionCopy(warnings: readonly { readonly code: string; readonly count?: number }[]): string | undefined {
  const omissions = warnings.filter(warning => ['invalid_url', 'invalid_title', 'unsupported_url_scheme'].includes(warning.code));
  if (!omissions.length) return undefined;
  const reasons = [...new Set(omissions.map(warning => ingressDiagnosticLabel(warning.code)))].join('; ');
  const count = omissions.reduce((sum, warning) => sum + (warning.count ?? 0), 0);
  if (omissions.every(warning => Number.isSafeInteger(warning.count) && warning.count! > 0)
    && Number.isSafeInteger(count) && count > 0) {
    return tn('firstRun_unsupportedCount', count,
      '$1 item will stay in this browser and will not sync: $2. Other bookmarks will sync.',
      '$1 items will stay in this browser and will not sync: $2. Other bookmarks will sync.', reasons);
  }
  // Older preview records have no item counts; never mistake reason kinds for item counts.
  return t('firstRun_unsupportedSkipped',
    'Some items will stay in this browser: $1. Other bookmarks will sync.',
    reasons);
}

export function paintPreviewTotals(totals: HTMLElement, preview: {
  readonly previewId: string; readonly bookmarkCount: number; readonly folderCount: number;
  readonly warnings: readonly { readonly code: string; readonly count?: number }[];
}, currentPreviewId: () => string | undefined, say: (copy: string, tone: 'info') => void): void {
  totals.textContent = firstRunTotalsCopy(preview.bookmarkCount, preview.folderCount);
  const omissions = previewOmissionCopy(preview.warnings);
  if (omissions) say(omissions, 'info');
  void metadataCounts().then(counts => {
    if (currentPreviewId() === preview.previewId && counts.tags + counts.notes + counts.descriptions > 0) {
      totals.textContent += ` · ${metadataCountsCopy(counts)}`;
    }
  }).catch(() => undefined);
}
