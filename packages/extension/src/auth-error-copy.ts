import { t } from './i18n.js';
/**
 * Single humanized copy table for auth/session error codes (UX-36).
 * Previously two parallel tables — login-form `humanize` and options
 * `recovery` — drifted apart; every surface now reads this one.
 * Known codes read as user language; an unknown code gets one generic line
 * and is never shown raw (R13 E-07).
 */
export function authErrorCopy(code: string | undefined, context: 'attempt' | 'state' = 'state'): string {
  if (!code) return t('auth_couldNotSignPlease', 'Could not sign in. Please try again.');
  if (code === 'invalid_credentials') return t('auth_emailPasswordIncorrect', 'Username, email or password is incorrect.');
  if (code === 'server_configuration_failed') return t('auth_serverConfigurationFailed', 'Check the server address and allow access before signing in.');
  if (code === 'verification_required') return t('auth_verifyEmailFirstCheck', 'Verify your email first — check your inbox, then sign in again.');
  if (code === 'rate_limited') return t('auth_tooManyRequestsTry', 'Too many requests. Try again shortly.');
  if (code === 'offline') return t('auth_checkConnectionTryAgain', 'Check your connection and try again.');
  if (code === 'user_gesture_required') return t('auth_useButtonStartSign', 'Use the button to start sign-in.');
  if (code === 'logout_gesture_required') return t('auth_useButtonSignOut', 'Use the button to sign out.');
  if (code === 'login_cancelled' || code.startsWith('login_cancelled:')) {
    return t('auth_signWindowDidNot', 'The sign-in window did not complete. Try again.');
  }
  if (code === 'otp_send_failed' || code === 'email_delivery_unavailable') {
    return t('auth_couldNotSendSign', 'Could not send a sign-in code. Try password sign-in or try again later.');
  }
  if (code === 'identity_unavailable' || code.startsWith('identity_unavailable:')) {
    return t('auth_couldNotStartProvider', 'Could not start provider sign-in. Try email sign-in.');
  }
  if (code === 'session_cookie_missing') return t('auth_signSucceededButSession', 'Sign-in succeeded but the session cookie was missing. Try again.');
  if (code === 'session_unavailable') return t('auth_couldNotRestoreSession', 'Could not restore the session. Please try again.');
  if (code === 'authentication_required' || code === 'credential_revoked' || code === 'invalid_grant') {
    return t('auth_accessRevokedSignAgain', 'Your access was revoked. Sign in again.');
  }
  if (code === 'binding_mismatch') {
    return t('auth_browserSignedOutBecause', 'This browser was signed out because the sign-in configuration changed. Sign in again.');
  }
  if (code === 'policy_blocked' || code === 'identityDisabled') {
    return t('auth_browserPolicyDoesNot', 'Your browser policy does not allow this sign-in.');
  }
  if (code === 'managed_configuration_conflict') return t('auth_managedSettingsConflictBuild', 'Managed settings conflict with this build.');
  if (code === 'manifest_invalid' || code.startsWith('manifest_')) return t('auth_serverConfigurationCouldNot', 'The server configuration could not be verified.');
  if (code === 'sync_unsupported') return t('auth_syncUnsupported', 'This server does not support bookmark sync yet.');
  if (code === 'library_unavailable') return t('auth_libraryUnavailable', 'Your bookmark library could not be loaded. Check your connection and try again.');
  if (code === 'collection_required' || code === 'collection_invalid') {
    return t('auth_libraryConnecting', 'You are signed in. Your bookmark library is connecting.');
  }
  // The page could not reach the extension's service worker, so the request
  // never got to the server. Blaming the credentials here sends people round
  // in circles retyping a correct password.
  if (code === 'extension_unavailable') {
    return t('auth_knowNCouldNot', 'Know-N could not reach its background service. Reload the extension, or restart the browser, then try again.');
  }
  if (code === 'csrf_failed') {
    return t('auth_knowNDidNot', 'Know-N did not accept sign-in from this copy of the extension. Reinstall it, or sign in on the Know-N website.');
  }
  if (code === 'authority_fenced') return t('auth_anotherSignSignOut', 'Another sign-in or sign-out interrupted this one. Try again.');
  // D-27: a failed attempt reads 'Sign-in failed'; a persistent session state
  // reads 'Sign-in problem'.
  return context === 'attempt'
    ? t('auth_signFailedTryAgain', 'Sign-in failed. Try again, or sign in on the Know-N website.')
    : t('auth_signProblemTryAgain', 'Sign-in problem. Try again, or sign in on the Know-N website.');
}
