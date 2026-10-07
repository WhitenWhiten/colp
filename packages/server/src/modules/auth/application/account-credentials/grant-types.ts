import type { CredentialGrantAction, CredentialGrantResourceKind } from './grant-actions.js';
import type {
  AccountCredentialAccountPorts,
  AccountCredentialClock,
  AccountCredentialStore,
} from './types.js';
import type { ProductCommandReceiptPort } from '../../../commands/index.js';

export type CredentialGrantState = 'active' | 'revoked' | 'expired';

export interface CredentialGrantResource {
  readonly kind: CredentialGrantResourceKind;
  readonly id: string;
}

export interface CredentialGrantRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly resource: CredentialGrantResource;
  readonly actions: readonly CredentialGrantAction[];
  readonly state: 'active' | 'revoked';
  readonly revision: bigint;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
}

export interface CredentialGrantDto {
  readonly id: string;
  readonly credentialId: string;
  readonly resource: CredentialGrantResource;
  readonly actions: readonly CredentialGrantAction[];
  readonly state: CredentialGrantState;
  readonly revision: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CredentialGrantPageDto {
  readonly items: readonly CredentialGrantDto[];
  readonly nextCursor: string | null;
}

export interface CredentialGrantInput {
  readonly credentialId: string;
  readonly resource: CredentialGrantResource;
  readonly actions: readonly CredentialGrantAction[];
  readonly expiresAt: string;
}

export interface CredentialGrantListFilters {
  readonly credentialId?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface PlanAuthorizationDto {
  readonly planId: string;
  readonly grantId: string;
  readonly planKind: CredentialGrantResourceKind;
  readonly planDigest: string;
  readonly approved: boolean;
  readonly expiresAt: string;
}

export interface CredentialPlanViewDto {
  readonly planKind: CredentialGrantResourceKind;
  readonly planId: string;
  readonly credentialId: string;
  readonly planDigest: string;
  readonly status: 'pending' | 'approved' | 'committing' | 'committed' | 'cancelled' | 'expired';
  readonly bindingCurrent: boolean;
  readonly requiredScopes: readonly string[];
  readonly expiresAt: string;
}

export interface StoredPlanBinding {
  readonly kind: 'authenticated';
  readonly principalId: string;
  readonly clientId: string;
  readonly credentialBindingId: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}

export interface StoredCredentialPlan {
  readonly planKind: CredentialGrantResourceKind;
  readonly planId: string;
  readonly operationsDigest: string;
  readonly requiredScopes: readonly string[];
  /** Null means an operation has no supported grant action (fail closed). */
  readonly requiredActions: readonly CredentialGrantAction[] | null;
  readonly status: string;
  readonly approvalStatus: string | null;
  readonly expiresAt: string;
  readonly binding: StoredPlanBinding;
  readonly resourceIds: readonly string[];
}

export interface CredentialPlanAuthorizationRecord {
  readonly planKind: CredentialGrantResourceKind;
  readonly planId: string;
  readonly grantId: string;
  readonly grantRevision: bigint;
  readonly credentialId: string;
  readonly planDigest: string;
  readonly authorizedAt: Date;
}

export interface CredentialGrantStore {
  insert(record: CredentialGrantRecord): Promise<void>;
  findById(id: string): Promise<CredentialGrantRecord | null>;
  lockById(id: string): Promise<CredentialGrantRecord | null>;
  listOwned(input: {
    readonly ownerAccountId: string;
    readonly credentialId?: string;
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly limit: number;
  }): Promise<readonly CredentialGrantRecord[]>;
  revoke(input: {
    readonly id: string;
    readonly expectedRevision: bigint;
    readonly reason: string;
    readonly revokedAt: Date;
    readonly revision: bigint;
  }): Promise<CredentialGrantRecord | null>;
  savePlanAuthorization(record: CredentialPlanAuthorizationRecord): Promise<void>;
  findPlanAuthorization(
    planKind: CredentialGrantResourceKind,
    planId: string,
  ): Promise<CredentialPlanAuthorizationRecord | null>;
  lockPlanAuthorization(
    planKind: CredentialGrantResourceKind,
    planId: string,
  ): Promise<CredentialPlanAuthorizationRecord | null>;
  findReportPublishAuthorization(input: {
    readonly seriesId: string;
    readonly editionId: string;
    readonly lock?: boolean;
  }): Promise<CredentialPlanAuthorizationRecord | null>;
  /** No-ops when the Plan is already not pending. */
  consumeReportPublishAuthorization(planId: string): Promise<void>;
}

export interface CredentialGrantResourcePort {
  collectionOwnedBy(collectionId: string, subjectId: string): Promise<boolean>;
  reportOwnedBy(reportId: string, subjectId: string): Promise<boolean>;
}

export interface CredentialPlanPort {
  getPlan(planKind: CredentialGrantResourceKind, planId: string): Promise<StoredCredentialPlan | null>;
  verifyDigest(plan: StoredCredentialPlan): boolean | Promise<boolean>;
  approvePlan(plan: StoredCredentialPlan): Promise<void>;
}

export interface CredentialGrantMachineBindingPort {
  issuer(): string;
  securityEpoch(): Promise<string>;
  expectedBindingId(input: {
    readonly clientId: string;
    readonly credentialId: string;
    readonly resourceAudience: string;
    readonly accountEpoch: string;
    readonly credentialEpoch: string;
    readonly ancestorEpochDigest: string;
    readonly serverSecurityEpoch: string;
  }): string;
}

export interface CredentialGrantCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly credentials: AccountCredentialStore;
  readonly accounts: AccountCredentialAccountPorts;
  readonly grants: CredentialGrantStore;
  readonly resources: CredentialGrantResourcePort;
  readonly plans: CredentialPlanPort;
  readonly machine: CredentialGrantMachineBindingPort;
  readonly clock: AccountCredentialClock;
  readonly ids: { nextGrantId(): string; nextCredentialId(): string; nextAccountId(): string; nextSubjectId(): string };
}

export const ACCOUNT_CREDENTIAL_GRANT_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const ACCOUNT_CREDENTIAL_PLAN_DIGEST_PATTERN = /^sha-256:[A-Za-z0-9_-]{43}$/;
