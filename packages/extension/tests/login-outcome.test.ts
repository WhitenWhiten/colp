import { expect, test, vi } from 'vitest';
import { SignedInSetupError, settleFailedLogin, signedInSetupAlert } from '../src/login-outcome.js';
import type { ExtensionRequest, ExtensionResponse } from '../src/types.js';

const base = { environment: 'production' as const, serverOrigin: 'https://know-n.com' };
const connected: ExtensionResponse = { ok: true, state: { ...base, status: 'connected', accountLabel: 'ada@example.com' } };
const signedOut: ExtensionResponse = { ok: true, state: { ...base, status: 'signed_out' } };

function ports(answer: ExtensionResponse | Promise<ExtensionResponse>) {
  const calls: string[] = [];
  const request = vi.fn(async (message: ExtensionRequest) => { calls.push(`request:${message.kind}`); return answer; });
  const render = vi.fn((_response: ExtensionResponse) => { calls.push('render'); });
  const alert = vi.fn((_view: unknown) => { calls.push('alert'); });
  return { calls, request, render, alert, all: { request, render, alert } };
}

test('a failed sign-in that left the browser signed in repaints the page as signed in, with the failure as an alert', async () => {
  const { calls, render, alert, all } = ports(connected);
  expect(await settleFailedLogin('session_invalid', all)).toBe(true);
  expect(render).toHaveBeenCalledWith(connected);
  expect(alert).toHaveBeenCalledWith({
    title: 'Signed in, sync is not ready',
    detail: 'You are signed in, but Know-N could not finish setting up sync. Try again in a moment.',
    action: 'Retry', actionKind: 'retry',
  });
  // The page is painted first (that clears the alert), and the failure goes on top of it.
  expect(calls).toEqual(['request:known.auth.status', 'render', 'alert']);
});

test('the alert keeps the words the table has for the failure', async () => {
  const { alert, all } = ports(connected);
  await settleFailedLogin('offline', all);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Check your connection and try again.' }));
  expect(signedInSetupAlert('rate_limited').detail).toBe('Too many requests. Try again shortly.');
  expect(signedInSetupAlert(undefined).detail).toBe('Could not sign in. Please try again.');
});

test('a failed sign-in that left the browser signed out leaves the page the failed answer painted', async () => {
  for (const answer of [signedOut,
    { ok: true, state: { ...base, status: 'offline', errorCode: 'offline' } } satisfies ExtensionResponse,
    { ok: false, error: 'extension_unavailable', state: { ...base, status: 'error', errorCode: 'extension_unavailable' } } satisfies ExtensionResponse]) {
    const { render, alert, all } = ports(answer);
    expect(await settleFailedLogin('invalid_credentials', all)).toBe(false);
    expect(render).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  }
});

test('the setup error is an Error carrying the failure code, so the form can word it as a setup failure', () => {
  const error = new SignedInSetupError('session_invalid');
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('session_invalid');
});
