import type { SiteDefinition } from './registry-types.js';
import type { ImportStatus } from './settings-import.js';

interface ReadStatus {
  error?: string; documents?: number; candidateAccount?: string | null;
  archive?: { config?: unknown; import?: ImportStatus | null };
}
interface Ports {
  status(): ReadStatus;
  refresh(): Promise<ReadStatus>;
  act(message: { kind: string; jobId?: string }): Promise<boolean>;
  disposed(): boolean;
  paint(): void;
  connect(): void;
  failed(code: string, kind: string): void;
}

/** Keep connection recovery visible and serialize the three entry points to a source check. */
export function installSiteImportActions(definition: SiteDefinition, ports: Ports) {
  let pending = false;
  const command = (job?: ImportStatus | null) => job?.phase === 'paused'
    ? { kind: 'known.siteAdapters.import.resume', jobId: job.id } : { kind: 'known.siteAdapters.import.start' };
  async function run(openSource: boolean) {
    if (pending) return;
    const original = ports.status().archive?.import, config = JSON.stringify(ports.status().archive?.config), message = command(original);
    pending = true; ports.paint();
    try {
      if (openSource) {
        // A tab can be open without a live extension connection. The worker can
        // reinject its adapter into that tab; opening another one does not fix it.
        const tabs = await chrome.tabs.query({ url: [...definition.matches] });
        if (!tabs.some(tab => tab.id !== undefined && !tab.incognito)) {
          await chrome.tabs.create({ url: definition.origin });
          for (let attempt = 0; attempt < 30 && !ports.disposed(); attempt++) {
            const next = await ports.refresh();
            if (ports.disposed() || next.error) return;
            if (JSON.stringify(next.archive?.config) !== config || next.archive?.import?.id !== original?.id) return;
            if (next.candidateAccount) { ports.connect(); return; }
            if (next.documents) break;
            if (attempt === 29) { ports.failed('pageUnavailable', message.kind); return; }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      if (ports.disposed()) return;
      const job = ports.status().archive?.import;
      if (job?.id !== original?.id || JSON.stringify(ports.status().archive?.config) !== config) return;
      if (job?.phase === 'scanning') { await ports.act({ kind: 'known.siteAdapters.reconnect' }); return; }
      if (job && !['paused', 'cancelled', 'completed'].includes(job.phase)) return;
      await ports.act(message);
    } catch { if (!ports.disposed()) ports.failed('unavailable', message.kind); }
    finally { pending = false; if (!ports.disposed()) ports.paint(); }
  }
  for (const id of ['start-import', 'resume-import', 'import-open-source']) {
    document.getElementById(id)!.addEventListener('click', () => { void run(id === 'import-open-source'); });
  }
  return { get pending() { return pending; } };
}
