/** Download-path Ack, capture, and cursor alignment. Terminal Push history cannot skip these. */
export function hasDownloadPathSettlement(facts: {
  readonly bootstrapAckComplete: boolean;
  readonly pendingAckCount: number;
  readonly pendingCaptureCount: number;
  readonly cursor: string | null;
  readonly ackedCursor: string | null;
}): boolean {
  return facts.bootstrapAckComplete && facts.pendingAckCount === 0 && facts.pendingCaptureCount === 0
    && facts.cursor !== null && facts.cursor === facts.ackedCursor;
}

/** A download-only bootstrap legitimately has no outbound Push receipt. */
export function hasFirstRunSettlementProof(facts: {
  readonly queueStatuses: readonly string[];
  readonly receiptCount: number;
  readonly bootstrapAckComplete: boolean;
  readonly pendingAckCount: number;
  readonly pendingCaptureCount: number;
  readonly cursor: string | null;
  readonly ackedCursor: string | null;
}): boolean {
  if (!hasDownloadPathSettlement(facts)) return false;
  if (facts.queueStatuses.length > 0) return facts.receiptCount > 0;
  return true;
}
