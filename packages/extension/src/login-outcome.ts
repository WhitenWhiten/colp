import { authErrorCopy } from './auth-error-copy.js';
import { t } from './i18n.js';
import type { AccountAlert } from './options-account.js';
import type { ExtensionRequest, ExtensionResponse, PublicAuthState } from './types.js';

/**
 * W2B-P3-4: a sign-in can work and the setup behind it still fail (the credential is stored, the Session or the library
 * could not be prepared). The worker answers that attempt as an error, so the page painted the sign-in form again, and on
 * the next open it showed a signed-in browser with no trace of what failed. This settles it the one honest way: read what
 * the browser really holds, paint that, and keep the failure in front of the person until they act on it.
 */
export interface FailedLoginPorts {
  readonly request: (message: ExtensionRequest) => Promise<ExtensionResponse>;
  /** Paints the whole page from an auth state. */
  readonly render: (response: ExtensionResponse) => void;
  /** Shows the Account page's alert (it stays until the next render). */
  readonly alert: (view: AccountAlert) => void;
}

/** A sign-in that worked and whose setup then failed. The toast words it as that, not as a failed sign-in. */
export class SignedInSetupError extends Error {}

/** The Account alert for a sign-in that worked and whose setup failed: what failed, and the one action that tries it again. */
export function signedInSetupAlert(failure: PublicAuthState['errorCode']): AccountAlert {
  return { title: t('options_signedInNotReady', 'Signed in, sync is not ready'), detail: authErrorCopy(failure, 'setup'),
    action: t('common_retry', 'Retry'), actionKind: 'retry' };
}

/**
 * After an attempt that did not end connected: when the browser holds a credential anyway, repaints the page as signed in and
 * shows the failure as an alert with Retry. Resolves true then; false when the attempt really left the browser signed out,
 * which is the page the failed answer already painted.
 */
export async function settleFailedLogin(failure: PublicAuthState['errorCode'], ports: FailedLoginPorts): Promise<boolean> {
  const actual = await ports.request({ kind: 'known.auth.status' });
  if (actual.state.status !== 'connected') return false;
  ports.render(actual);
  ports.alert(signedInSetupAlert(failure));
  return true;
}
