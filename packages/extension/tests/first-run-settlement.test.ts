import { expect, test } from 'vitest';
import { hasDownloadPathSettlement, hasFirstRunSettlementProof } from '../e2e/first-run-settlement.js';

const downloaded = { queueStatuses: [], receiptCount: 0, bootstrapAckComplete: true,
  pendingAckCount: 0, pendingCaptureCount: 0, cursor: 'cursor-1', ackedCursor: 'cursor-1' };

test('accepts a pure download only after its bootstrap and cursor Ack have settled', () => {
  expect(hasFirstRunSettlementProof(downloaded)).toBe(true);
  expect(hasFirstRunSettlementProof({ ...downloaded, bootstrapAckComplete: false })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, ackedCursor: 'older' })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, cursor: null, ackedCursor: null })).toBe(false);
});

test('does not mistake an empty Push queue for settled pending browser or Ack work', () => {
  expect(hasFirstRunSettlementProof({ ...downloaded, pendingAckCount: 1 })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, pendingCaptureCount: 1 })).toBe(false);
});

test('still requires Push receipts when the run actually queued outbound operations', () => {
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['terminal'] })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['pending'] })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['terminal'], receiptCount: 1 })).toBe(true);
});

test('historical terminal receipts cannot mask unsettled Ack, capture, or cursor', () => {
  expect(hasFirstRunSettlementProof({
    queueStatuses: ['terminal'], receiptCount: 1, bootstrapAckComplete: false,
    pendingAckCount: 1, pendingCaptureCount: 1, cursor: 'new', ackedCursor: 'old',
  })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['terminal'], receiptCount: 1,
    bootstrapAckComplete: false })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['terminal'], receiptCount: 1,
    pendingAckCount: 1 })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['terminal'], receiptCount: 1,
    pendingCaptureCount: 1 })).toBe(false);
  expect(hasFirstRunSettlementProof({ ...downloaded, queueStatuses: ['terminal'], receiptCount: 1,
    cursor: 'new', ackedCursor: 'old' })).toBe(false);
  expect(hasDownloadPathSettlement({
    bootstrapAckComplete: false, pendingAckCount: 1, pendingCaptureCount: 1, cursor: 'new', ackedCursor: 'old',
  })).toBe(false);
});
