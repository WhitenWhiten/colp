import type { InternalAdapter } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { decideOAuthOccupancyAdopt, executeOAuthOccupancyAdopt } from '../../modules/auth/index.js';
import type { BetterAuthRuntimeInput } from './better-auth-runtime-contract.js';

type AdapterCall<Method extends (...args: never[]) => unknown> =
  (...args: Parameters<Method>) => ReturnType<Method>;

/**
 * Better Auth 1.7.1 callback boundary. Only this request's context is replaced.
 * The SDK first creates a user, then an account, then the callback session;
 * adoption must revoke the old sessions before the last step.
 */
export function applyOAuthOccupancyAdoptToAdapter(
  context: { internalAdapter: InternalAdapter },
  onAdopted: BetterAuthRuntimeInput<never>['onOAuthOccupancyAdopted'],
): void {
  const adapter = context.internalAdapter;
  const pendingAdopt = new Map<string, {
    readonly existingUser: NonNullable<Awaited<ReturnType<InternalAdapter['findUserByEmail']>>>['user'];
    readonly providerUser: Parameters<InternalAdapter['createUser']>[0];
  }>();
  const findUserByEmail: InternalAdapter['findUserByEmail'] = async (...args) => {
    const found = await adapter.findUserByEmail(...args);
    return found?.user.emailVerified === false ? null : found;
  };
  const createUser: AdapterCall<InternalAdapter['createUser']> = async (user, source) => {
    const existing = user.email.length > 0 ? await adapter.findUserByEmail(user.email) : null;
    const decision = decideOAuthOccupancyAdopt({
      occupancy: existing?.user ? { emailVerified: existing.user.emailVerified === true } : null,
      providerEmailVerified: user.emailVerified === true,
    });
    if (decision === 'adopt' && existing !== null) {
      pendingAdopt.set(existing.user.id, { existingUser: existing.user, providerUser: user });
      return existing.user;
    }
    if (decision === 'refuse') {
      throw APIError.from('UNPROCESSABLE_ENTITY', {
        code: 'SOCIAL_ACCOUNT_ALREADY_LINKED', message: 'account not linked',
      });
    }
    return adapter.createUser(user, source);
  };
  const createAccount: AdapterCall<InternalAdapter['createAccount']> = async (account) => {
    const pending = pendingAdopt.get(account.userId);
    if (pending === undefined) return adapter.createAccount(account);
    pendingAdopt.delete(account.userId);
    // The domain adoption unit owns compensation/order. Capture the SDK result
    // here so its complete account shape survives the domain's minimal port.
    let linked: Awaited<ReturnType<InternalAdapter['linkAccount']>> | undefined;
    await executeOAuthOccupancyAdopt({
      userId: account.userId,
      existingUser: pending.existingUser,
      providerUser: { ...pending.providerUser, emailVerified: pending.providerUser.emailVerified === true },
      account,
      adapter: {
        findAccounts: (userId) => adapter.findAccounts(userId),
        deleteAccount: (id) => adapter.deleteAccount(id),
        linkAccount: async (data) => {
          linked = await adapter.linkAccount({
            ...account,
            issuer: typeof data.issuer === 'string' ? data.issuer : account.issuer,
          });
          return linked;
        },
        updateUser: (userId, data) => adapter.updateUser(userId, data),
      },
      onAdopted,
    });
    if (linked === undefined) throw new Error('OAuth adoption did not create an account.');
    return linked;
  };
  const overrides = { findUserByEmail, createUser, createAccount };
  context.internalAdapter = new Proxy(adapter, {
    get(target, prop, receiver) {
      if (Object.hasOwn(overrides, prop)) return Reflect.get(overrides, prop);
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
