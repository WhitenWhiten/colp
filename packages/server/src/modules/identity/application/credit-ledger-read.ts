import type { components } from '../../../../generated/openapi/product-v1.js';

export type CreditLedgerKind = components['schemas']['CreditKind'];
export type CreditLedgerSource = components['schemas']['CreditSource'];
export type CreditLedgerBalanceFacts = components['schemas']['CreditBalance'];
export type CreditLedgerEntryFacts = components['schemas']['CreditLedgerEntry'];
export type CreditLedgerEntryBalanceFacts = CreditLedgerEntryFacts['balanceAfter'];
export type CreditLedgerTaskFacts = components['schemas']['CreditTask'];
export type CreditLedgerSnapshotFacts = components['schemas']['CreditLedgerSnapshot'];

export interface CreditLedgerFilters {
  readonly kind?: CreditLedgerKind;
  readonly from?: string;
  readonly to?: string;
  readonly chargeId?: string;
  readonly runId?: string;
}


export interface CreditLedgerReadPageFacts {
  readonly accountId: string;
  readonly snapshot: CreditLedgerSnapshotFacts;
  readonly items: readonly CreditLedgerEntryFacts[];
  readonly hasMore: boolean;
}

export interface CreditLedgerReadPort {
  readonly readLatest: (accountId: string, filters: CreditLedgerFilters, limit: number) => Promise<
    | { readonly kind: 'ready'; readonly page: CreditLedgerReadPageFacts }
    | { readonly kind: 'reconciling' }
  >;
  readonly readPage: (accountId: string, input: {
    readonly filters: CreditLedgerFilters;
    readonly limit: number;
    readonly highSequence: string;
    readonly beforeSequence: string;
    readonly snapshot: CreditLedgerSnapshotFacts;
  }) => Promise<CreditLedgerReadPageFacts>;
  readonly readEntry: (accountId: string, entryId: string) => Promise<CreditLedgerEntryFacts | null>;
}
