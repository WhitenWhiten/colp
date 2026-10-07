/**
 * Explicit provider-link completion. Password credential inserts stay on
 * commit_password_security_event. A single auth account is creation, including
 * occupancy adopt (that path already raised before the provider row existed).
 */
import type { BusinessAccountUnitOfWork } from './business-account-mapping.js';
import type { SecurityEpochBridge } from './security-epoch-bridge.js';

export function completedProviderLinkRaisesEpoch(input: {
  readonly providerId: string;
  readonly hasPassword: boolean;
  readonly accountCount: number;
}): boolean {
  if (input.providerId === 'credential' || input.hasPassword) return false;
  return input.accountCount > 1;
}

const occupancyProviderLinks = new Set<string>();

/** Occupancy adopt already raised the epoch before it links the provider row. */
export async function withoutProviderLinkEpoch<T>(userId: string, work: () => Promise<T>): Promise<T> {
  occupancyProviderLinks.add(userId);
  try {
    return await work();
  } finally {
    occupancyProviderLinks.delete(userId);
  }
}

export async function observeCompletedProviderAccount(input: {
  readonly account: {
    readonly providerId?: unknown;
    readonly userId?: unknown;
    readonly password?: unknown;
  };
  readonly accountCount: (userId: string) => Promise<number>;
  readonly raiseProviderLink: (authUserId: string) => Promise<void>;
}): Promise<void> {
  const providerId = typeof input.account.providerId === 'string' ? input.account.providerId : '';
  const userId = typeof input.account.userId === 'string' ? input.account.userId : '';
  if (providerId.length === 0 || userId.length === 0) return;
  const hasPassword = typeof input.account.password === 'string' && input.account.password.length > 0;
  // Credential and password inserts are the password trigger's single bump.
  // Occupancy adopt already revoked sessions before linkAccount.
  if (providerId === 'credential' || hasPassword || occupancyProviderLinks.has(userId)) return;
  const accountCount = await input.accountCount(userId);
  if (!completedProviderLinkRaisesEpoch({ providerId, hasPassword, accountCount })) return;
  await input.raiseProviderLink(userId);
}

export function createProviderLinkEpochHandler(input: {
  readonly businessAccount: BusinessAccountUnitOfWork;
  readonly securityEpochBridge: SecurityEpochBridge;
}): (event: { readonly authUserId: string }) => Promise<void> {
  return async (event) => {
    const accountId = await input.businessAccount.execute(async (ports) => {
      const mapping = await ports.mappings.findByAuthUserId(event.authUserId);
      if (!mapping) {
        throw new Error('provider link requires a business mapping');
      }
      return mapping.accountId;
    });
    await input.securityEpochBridge.raiseAccountSecurityEvent('provider_link', accountId);
  };
}
