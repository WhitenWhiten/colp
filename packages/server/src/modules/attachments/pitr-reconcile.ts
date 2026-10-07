/**
 * P4A-I15 PITR reconciliation: compare the DB generation ledger with
 * per-exact-key R2 facts via the read-only object store.
 *
 * For every NON-deleted generation claimed from the ledger, the reconciler
 * performs an exact-key HEAD (`headExact`) — NEVER a bucket list — and reports
 * match / missing / mismatch / unknown. A mismatch (exact key exists with
 * different etag/size than the ledger bound) is a QUARANTINE CANDIDATE; the
 * reconciler performs NO destructive action by itself
 * (`destructiveActionsTaken: false` is structural). Provider retryable /
 * denied / unknown heads are classified `unknown` (environment), never
 * mismatch — provider throttling is not contract corruption.
 *
 * The report never serializes physical keys, credentials, or URLs; only
 * generation ids and fixed detail codes.
 */
export interface PitrLedgerRow {
  readonly generationId: string;
  readonly blobId: string;
  readonly key: string;
  readonly bucket: string;
  readonly generationState: string;
  readonly expectedEtag: string | null;
  readonly expectedSize: number | null;
}

export interface PitrLedgerPort {
  /** All non-deleted claimed generations (per-exact-key; no bucket list). */
  listClaimedGenerations(): Promise<readonly PitrLedgerRow[]>;
}

export type PitrHeadOutcome =
  | { readonly class: 'ok'; readonly etag: string; readonly size: number }
  | { readonly class: 'not_found' }
  | { readonly class: 'denied' }
  | { readonly class: 'retryable' }
  | { readonly class: 'unknown' };

export interface PitrObjectStorePort {
  headExact(handle: { readonly generationId: string; readonly key: string }): Promise<PitrHeadOutcome>;
}

export type PitrGenerationVerdict = 'match' | 'missing' | 'mismatch' | 'unknown';

export interface PitrFinding {
  readonly generationId: string;
  readonly verdict: PitrGenerationVerdict;
  /** Fixed code; no key/URL/secret material. */
  readonly detail: string;
}

export interface PitrReconcileReport {
  readonly plane: 'reconcile';
  readonly generatedAtIso: string;
  readonly counts: Readonly<Record<PitrGenerationVerdict, number>>;
  readonly findings: ReadonlyArray<PitrFinding>;
  /** Mismatch generations only — the operator isolates these before any delete. */
  readonly quarantineCandidates: ReadonlyArray<string>;
  /** Structural: this reconciler never deletes or writes. */
  readonly destructiveActionsTaken: false;
  readonly method: 'per_exact_key_head';
}

export async function reconcileGenerationLedger(input: {
  readonly ledger: PitrLedgerPort;
  readonly objectStore: PitrObjectStorePort;
  readonly nowIso?: string;
}): Promise<PitrReconcileReport> {
  const rows = await input.ledger.listClaimedGenerations();
  const findings: PitrFinding[] = [];

  for (const row of rows) {
    const outcome = await input.objectStore.headExact({ generationId: row.generationId, key: row.key });
    let verdict: PitrGenerationVerdict;
    let detail: string;
    switch (outcome.class) {
      case 'ok': {
        const etagMatches = row.expectedEtag === null || outcome.etag === row.expectedEtag;
        const sizeMatches = row.expectedSize === null || outcome.size === row.expectedSize;
        if (etagMatches && sizeMatches) {
          verdict = 'match';
          detail = `state_${row.generationState}`;
        } else {
          verdict = 'mismatch';
          detail = 'etag_or_size_mismatch';
        }
        break;
      }
      case 'not_found':
        verdict = 'missing';
        detail = `state_${row.generationState}`;
        break;
      case 'denied':
        verdict = 'unknown';
        detail = 'provider_denied';
        break;
      case 'retryable':
        verdict = 'unknown';
        detail = 'provider_retryable';
        break;
      case 'unknown':
        verdict = 'unknown';
        detail = 'provider_unknown';
        break;
    }
    findings.push({ generationId: row.generationId, verdict, detail });
  }

  const counts: Record<PitrGenerationVerdict, number> = { match: 0, missing: 0, mismatch: 0, unknown: 0 };
  for (const finding of findings) counts[finding.verdict] += 1;
  const quarantineCandidates = findings
    .filter((finding) => finding.verdict === 'mismatch')
    .map((finding) => finding.generationId);

  return Object.freeze({
    plane: 'reconcile',
    generatedAtIso: input.nowIso ?? new Date().toISOString(),
    counts: Object.freeze(counts),
    findings: Object.freeze(findings),
    quarantineCandidates: Object.freeze(quarantineCandidates),
    destructiveActionsTaken: false,
    method: 'per_exact_key_head',
  });
}