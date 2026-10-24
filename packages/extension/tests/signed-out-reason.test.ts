// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { authErrorCopy } from '../src/auth-error-copy.js';
import { bindHubChrome } from '../src/options-hub-chrome.js';
import { endedSignInCopy, endedSignInReason, paintSignedOut, signInHasEnded } from '../src/signed-out-reason.js';

const KEPT = 'Sync is paused. Your bookmarks and any changes that have not synced yet are kept here.';
const BASE_LEDE = 'Saving, organizing and backups work without an account. Sign in to sync your library on every device.';
const BASE_TITLE = 'Connect this browser';
const BASE_HINT = 'Sign in to sync and import into your library. Saving, organizing and HTML import work without an account.';

function nodes() {
  document.body.innerHTML = `<p id="lede">${BASE_LEDE}</p><div id="connect"><p class="empty-title">${BASE_TITLE}</p><p class="empty-hint">${BASE_HINT}</p></div>`;
  const connect = document.getElementById('connect')!;
  return { lede: document.getElementById('lede')!, connect,
    title: connect.querySelector('.empty-title')!, hint: connect.querySelector('.empty-hint')! };
}

test.each([
  ['signed_out', 'session_expired', 'session_expired'],
  ['signed_out', 'authentication_required', 'authentication_required'],
  ['signed_out', 'credential_revoked', 'credential_revoked'],
  ['signed_out', 'binding_mismatch', 'binding_mismatch'],
  // The first read after the sign-in configuration changed answers `error` and has already cleared the credential.
  ['error', 'binding_mismatch', 'binding_mismatch'],
  // Signing out on purpose, a browser that never signed in, and every state that is not an ended sign-in carry no reason.
  ['signed_out', undefined, undefined],
  ['signed_out', 'logout_gesture_required', undefined],
  ['connected', undefined, undefined],
  ['connected', 'session_expired', undefined],
  ['offline', 'offline', undefined],
  ['refreshing', 'session_expired', undefined],
  ['error', 'session_expired', undefined],
  ['error', 'credential_revoked', undefined],
  ['policy_blocked', 'policy_blocked', undefined],
] as const)('a %s state with %s reads as the ended sign-in %s', (status, errorCode, expected) => {
  expect(endedSignInReason({ status, ...(errorCode ? { errorCode } : {}) })).toBe(expected);
});

test('only the codes that say the sign-in is over are sign-in-ended', () => {
  for (const code of ['session_expired', 'authentication_required', 'credential_revoked', 'binding_mismatch']) expect(signInHasEnded(code)).toBe(true);
  for (const code of [undefined, 'offline', 'server_unavailable', 'rate_limited', 'invalid_credentials', 'session_invalid', 'sync_unsupported']) {
    expect(signInHasEnded(code)).toBe(false);
  }
});

test('the sentence tells expired from revoked from reconfigured, and says nothing here was lost', () => {
  expect(endedSignInCopy('session_expired')).toBe(`Your session expired. Sign in again. ${KEPT}`);
  expect(endedSignInCopy('authentication_required')).toBe(`Your access was revoked. Sign in again. ${KEPT}`);
  expect(endedSignInCopy('credential_revoked')).toBe(`Your access was revoked. Sign in again. ${KEPT}`);
  expect(endedSignInCopy('binding_mismatch')).toBe(
    `This browser was signed out because the sign-in configuration changed. Sign in again. ${KEPT}`);
  for (const reason of ['session_expired', 'authentication_required', 'binding_mismatch']) {
    // The reason is one of the table's, never a raw code.
    expect(endedSignInCopy(reason)).not.toContain(reason);
  }
});

test('the Account lede and the Sync tab card say the sign-in ended, and read as before when it did not', () => {
  const { lede, title, hint, connect } = nodes();
  paintSignedOut({ lede, connect }, 'session_expired');
  expect(lede.textContent).toBe(endedSignInCopy('session_expired'));
  expect(title.textContent).toBe('Sign in again');
  expect(hint.textContent).toBe(endedSignInCopy('session_expired'));
  paintSignedOut({ lede, connect }, 'binding_mismatch');
  expect(lede.textContent).toContain('sign-in configuration changed');
  // Signing in again (or out on purpose) takes the reason away, and the page speaks as it did before.
  paintSignedOut({ lede, connect }, undefined);
  expect(lede.textContent).toBe(BASE_LEDE);
  expect(title.textContent).toBe(BASE_TITLE);
  expect(hint.textContent).toBe(BASE_HINT);
});

test('a card without the empty-state parts is left to its own words', () => {
  document.body.innerHTML = '<p id="lede"></p><div id="connect"></div>';
  const lede = document.getElementById('lede')!;
  expect(() => { paintSignedOut({ lede, connect: document.getElementById('connect')! }, 'session_expired'); }).not.toThrow();
  expect(lede.textContent).toContain('Your session expired.');
});

function sidebar() {
  document.body.innerHTML = '<span id="side-name"></span><span id="hub-dot" hidden></span><a id="hub-signin" hidden>Sign in</a><span id="hub-status"></span>';
  const node = (id: string) => document.getElementById(id)!;
  return { line: node('hub-status'), name: node('side-name'), signIn: node('hub-signin'),
    chrome: bindHubChrome({ name: node('side-name'), line: node('hub-status'), dot: node('hub-dot'), signIn: node('hub-signin') }) };
}

test('the sidebar line continues "Sign in" with "again to resume sync" while the sign-in is ended', () => {
  const { line, name, signIn, chrome } = sidebar();
  chrome.setAccount('signed_out', undefined, true);
  expect(`${signIn.textContent} ${line.textContent}`).toBe('Sign in again to resume sync');
  expect(signIn.hidden).toBe(false);
  expect(name.textContent).toBe('Not signed in');
  // Another settle of the engine's phase (it paints the account line while there is no connection) keeps the words.
  chrome.setEnginePhase(undefined, false);
  expect(line.textContent).toBe('again to resume sync');
  chrome.setAccount('signed_out');
  expect(line.textContent).toBe('for optional sync');
});

test('the ended flag speaks only for a signed-out browser', () => {
  const { line, chrome } = sidebar();
  chrome.setAccount('error', undefined, true);
  expect(line.textContent).toBe('Sign-in problem');
  chrome.setAccount('offline', undefined, true);
  expect(line.textContent).toBe('Offline');
  chrome.setAccount('connected', 'Ada', true);
  expect(line.textContent).toBe('Signed in');
});

test('a sign-in that worked and whose setup failed is not worded as a failed sign-in', () => {
  const setup = 'You are signed in, but Know-N could not finish setting up sync. Try again in a moment.';
  // A code the table does not know gets the generic line, and the context decides which one.
  expect(authErrorCopy('session_invalid', 'setup')).toBe(setup);
  expect(authErrorCopy('operation_failed', 'setup')).toBe(setup);
  expect(authErrorCopy('operation_failed', 'attempt')).toBe('Sign-in failed. Try again, or sign in on the Know-N website.');
  expect(authErrorCopy('operation_failed')).toBe('Sign-in problem. Try again, or sign in on the Know-N website.');
  // A code the table has words for keeps them in every context.
  expect(authErrorCopy('offline', 'setup')).toBe('Check your connection and try again.');
  expect(authErrorCopy('rate_limited', 'setup')).toBe(authErrorCopy('rate_limited', 'attempt'));
  expect(authErrorCopy('authority_fenced', 'setup')).toBe('Another sign-in or sign-out interrupted this one. Try again.');
});
