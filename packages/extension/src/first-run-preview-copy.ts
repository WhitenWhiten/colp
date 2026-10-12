import { metadataCounts, metadataCountsCopy } from './metadata-transfer.js';
import { firstRunTotalsCopy } from './first-run-draft.js';
import { ingressDiagnosticLabel } from './ingress-diagnostics-ui.js';
import { t } from './i18n.js';

export function previewOmissionCopy(warnings: readonly { readonly code: string }[]): string | undefined {
  const omissions = warnings.filter(warning => ['invalid_url', 'invalid_title', 'unsupported_url_scheme'].includes(warning.code));
  return omissions.length ? t('firstRun_unsupportedSkipped',
    'Some items will stay in this browser: $1. Other bookmarks will sync.',
    omissions.map(warning => ingressDiagnosticLabel(warning.code)).join('; ')) : undefined;
}

export function paintPreviewTotals(totals: HTMLElement, preview: {
  readonly previewId: string; readonly bookmarkCount: number; readonly folderCount: number;
  readonly warnings: readonly { readonly code: string }[];
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
