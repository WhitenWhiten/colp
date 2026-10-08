import { describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { applyOAuthOccupancyAdoptToAdapter } from '../../../src/infrastructure/auth/better-auth-occupancy-adapter.js';

async function sdkAdapter(emailVerified: boolean) {
  const now = new Date();
  const user = { id: 'user-1', email: 'user@example.com', name: 'User', emailVerified, createdAt: now, updatedAt: now };
  const account = { id: 'account-1', userId: user.id, providerId: 'google', issuer: 'https://accounts.google.com', accountId: 'provider-1', createdAt: now, updatedAt: now };
  const auth = betterAuth({
    baseURL: 'https://app.example.test', secret: 'test-secret-that-is-long-enough-for-better-auth', // secret-scan: allow 'test-secret-that-is-long-enough-for-better-auth'
    database: memoryAdapter({ user: [user], account: [account] }),
    logger: { level: 'error' },
  });
  return (await auth.$context).internalAdapter;
}

describe('locked Better Auth occupancy adapter contract', () => {
  it('uses the installed SDK shape and forwards includeAccounts and complete results', async () => {
    const adapter = await sdkAdapter(true);
    expect('findOAuthUser' in adapter).toBe(false);
    expect(typeof adapter.createOAuthUser).toBe('function');
    const find = vi.spyOn(adapter, 'findUserByEmail');
    const request = { internalAdapter: adapter };
    applyOAuthOccupancyAdoptToAdapter(request, undefined);
    const options = { includeAccounts: true };
    const result = await request.internalAdapter.findUserByEmail('user@example.com', options);
    expect(find).toHaveBeenLastCalledWith('user@example.com', options);
    expect(result?.accounts).toHaveLength(1);
    expect(result?.accounts[0]).toMatchObject({ id: 'account-1', providerId: 'google' });
    expect(result?.user.name).toBe('User');
    await request.internalAdapter.findUserByEmail('user@example.com', { includeAccounts: false });
    expect(find).toHaveBeenLastCalledWith('user@example.com', { includeAccounts: false });
  });

  it('hides unverified occupancy only on the wrapped request', async () => {
    const adapter = await sdkAdapter(false);
    const request = { internalAdapter: adapter };
    applyOAuthOccupancyAdoptToAdapter(request, undefined);
    expect(await request.internalAdapter.findUserByEmail('user@example.com', { includeAccounts: true })).toBeNull();
    expect((await adapter.findUserByEmail('user@example.com'))?.user.id).toBe('user-1');
    expect(request.internalAdapter).not.toBe(adapter);
  });
});
