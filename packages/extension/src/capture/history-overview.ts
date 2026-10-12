import type { CaptureStatistics } from './statistics.js';
import { renderCaptureCharts } from './charts.js';

/** Help › Saving statistics: the charts that ride along with a history load. */
export function createHistoryOverview(host: HTMLElement | null) {
  return {
    render(statistics: CaptureStatistics, select: (status: string, day?: string) => void): void {
      if (host) renderCaptureCharts(host, statistics, select);
    },
    clear(): void { host?.replaceChildren(); },
  };
}
