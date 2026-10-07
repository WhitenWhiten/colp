import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SPOOL_UNAVAILABLE = ['ENOSPC', 'EROFS', 'EACCES', 'EDQUOT'] as const;

export function ledgerArchiveSpoolErrno(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

export function isLedgerArchiveSpoolUnavailable(error: unknown): boolean {
  const code = ledgerArchiveSpoolErrno(error);
  return code !== undefined && (SPOOL_UNAVAILABLE as readonly string[]).includes(code);
}

export interface ReclaimLedgerArchiveSpoolResult {
  readonly removed: number;
  readonly skipped: number;
}

/** Delete leftover `*.jsonl` older than maxAgeMs. In-flight files are skipped. */
export function reclaimLedgerArchiveSpoolSync(
  directory: string,
  options: {
    readonly now?: number;
    readonly maxAgeMs?: number;
    /** Test seam: root bypasses directory mode bits, so CI injects unlink errors. */
    readonly unlink?: (path: string) => void;
  } = {},
): ReclaimLedgerArchiveSpoolResult {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 300_000;
  const unlink = options.unlink ?? unlinkSync;
  let removed = 0;
  let skipped = 0;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (ledgerArchiveSpoolErrno(error) === 'ENOENT') return Object.freeze({ removed: 0, skipped: 0 });
    throw spoolUnavailable(error);
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      skipped += 1;
      continue;
    }
    const path = join(directory, name);
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) {
        skipped += 1;
        continue;
      }
      unlink(path);
      removed += 1;
    } catch (error) {
      if (isLedgerArchiveSpoolUnavailable(error)) throw spoolUnavailable(error);
      skipped += 1;
    }
  }
  return Object.freeze({ removed, skipped });
}

function spoolUnavailable(cause: unknown): Error {
  return Object.assign(new Error('archive_spool_unavailable'), {
    stableCode: 'archive_spool_unavailable',
    cause,
  });
}
