// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { authErrorCopy } from '../src/auth-error-copy.js';
import { bindLoginForm, resetPasswordCommand } from '../src/login-form.js';

function mountForm(): void {
  document.body.innerHTML = `
    <div id="login-tabs">
      <button id="login-tab-password" type="button">Password</button>
      <button id="login-tab-otp" type="button">Email code</button>
    </div>
    <form id="login-form">
      <input id="login-email"><p id="login-email-error" hidden></p>
      <div id="login-password-field"><input id="login-password" type="password">
        <button id="login-password-toggle" type="button" aria-pressed="false"></button><p id="login-password-error" hidden></p></div>
      <div id="login-otp-field"><input id="login-otp-code"><button id="login-send-otp" type="button"></button><p id="login-otp-error" hidden></p></div>
      <button id="login-submit" type="submit">Sign in</button>
      <button id="login-google" type="button"></button>
      <button id="login-github" type="button"></button>
    </form>
    <div id="login-social-divider"></div><div id="login-social"></div>
    <p><a id="login-forgot"></a></p><p id="login-registration"></p>
    <details id="login-password-help" hidden><code id="login-reset-command"></code></details>`;
}

function trustedClick(target: HTMLElement): void {
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(click, 'isTrusted', { value: true });
  target.dispatchEvent(click);
}

function type(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

test('Sign in stays pressable like the web: an empty field says so under itself, any password goes to the server', async () => {
  mountForm();
  const signInPassword = vi.fn(async () => undefined);
  bindLoginForm({ signInPassword, sendOtp: vi.fn(async () => undefined), signInOtp: vi.fn(async () => undefined), startOAuth: vi.fn(async () => undefined) });
  const submit = document.getElementById('login-submit') as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  type('login-email', 'reader@example.com');
  trustedClick(submit);
  expect(signInPassword).not.toHaveBeenCalled();
  expect(document.getElementById('login-password-error')!.hidden).toBe(false);
  expect(document.getElementById('login-password-error')!.textContent).toBe('Enter your password.');
  expect(document.getElementById('login-password')!.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById('login-email-error')!.hidden).toBe(true);
  expect(document.activeElement?.id).toBe('login-password');
  // The server decides whether a password is right; older accounts may have short ones.
  type('login-password', 'abc');
  expect(document.getElementById('login-password-error')!.hidden).toBe(true);
  trustedClick(submit);
  await vi.waitFor(() => expect(signInPassword).toHaveBeenCalledWith('reader@example.com', 'abc'));
});

test('the eye shows the password, and the reset command follows the username typed', () => {
  mountForm();
  bindLoginForm({ signInPassword: vi.fn(), sendOtp: vi.fn(), signInOtp: vi.fn(), startOAuth: vi.fn() });
  const password = document.getElementById('login-password') as HTMLInputElement;
  const reveal = document.getElementById('login-password-toggle')!;
  reveal.click();
  expect(password.type).toBe('text');
  expect(reveal.getAttribute('aria-pressed')).toBe('true');
  reveal.click();
  expect(password.type).toBe('password');
  const command = document.getElementById('login-reset-command')!;
  expect(command.textContent).toBe('docker compose exec server colp-server reset-password --username <username>');
  type('login-email', 'alice');
  expect(command.textContent).toBe(resetPasswordCommand('alice'));
  expect(command.textContent).toMatch(/--username alice$/u);
  // An email is not a username: the placeholder stays.
  type('login-email', 'alice@example.com');
  expect(command.textContent).toMatch(/--username <username>$/u);
});

test('an unknown auth code reads as a sentence without the raw code', () => {
  const copy = authErrorCopy('upstream_teapot_418');
  expect(copy).toBe('Sign-in problem. Try again, or sign in on the Know-N website.');
  expect(copy).not.toContain('upstream_teapot_418');
});

test('self-hosted mode resets OTP to password and hides unavailable sign-in methods', () => {
  mountForm();
  const form = bindLoginForm({ signInPassword: vi.fn(), sendOtp: vi.fn(), signInOtp: vi.fn(), startOAuth: vi.fn() });
  document.getElementById('login-tab-otp')!.click();
  expect((document.getElementById('login-email') as HTMLInputElement).type).toBe('email');
  form.setCloudEnabled(false);
  type('login-email', 'alice'); type('login-password', 'test-password');
  expect((document.getElementById('login-email') as HTMLInputElement).autocomplete).toBe('username');
  expect((document.getElementById('login-email') as HTMLInputElement).type).toBe('text');
  expect(document.getElementById('login-tab-password')!.getAttribute('aria-selected')).toBe('true');
  expect((document.getElementById('login-submit') as HTMLButtonElement).disabled).toBe(false);
  for (const id of ['login-tabs', 'login-tab-otp', 'login-social', 'login-social-divider', 'login-registration']) {
    expect(document.getElementById(id)!.hidden).toBe(true);
  }
  expect(document.getElementById('login-forgot')!.parentElement!.hidden).toBe(true);
  expect(document.getElementById('login-password-help')!.hidden).toBe(false);
  document.getElementById('login-tab-password')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  expect(document.getElementById('login-tab-password')!.getAttribute('aria-selected')).toBe('true');
  form.setCloudEnabled(true);
  expect(document.getElementById('login-tabs')!.hidden).toBe(false);
  expect(document.getElementById('login-social')!.hidden).toBe(false);
  expect(document.getElementById('login-password-help')!.hidden).toBe(true);
  document.getElementById('login-tab-otp')!.click();
  expect((document.getElementById('login-email') as HTMLInputElement).autocomplete).toBe('email');
});

test('failures that never reached the credentials do not read as a wrong sign-in', () => {
  expect(authErrorCopy('extension_unavailable', 'attempt')).toMatch(/background service/u);
  expect(authErrorCopy('csrf_failed', 'attempt')).toMatch(/this copy of the extension/u);
  expect(authErrorCopy('authority_fenced', 'attempt')).toMatch(/interrupted/u);
});

test('a rejected password is an announced error toast that marks both inputs, like the web', async () => {
  mountForm();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  bindLoginForm({
    signInPassword: vi.fn(async () => { throw new Error('invalid_credentials'); }),
    sendOtp: vi.fn(async () => undefined),
    signInOtp: vi.fn(async () => undefined),
    startOAuth: vi.fn(async () => undefined),
  });
  type('login-email', 'reader@example.com');
  type('login-password', 'wrong');
  const submit = document.getElementById('login-submit') as HTMLButtonElement;
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(click, 'isTrusted', { value: true });
  submit.dispatchEvent(click);
  await vi.waitFor(() => expect(document.querySelector('.toast--error')).not.toBeNull());
  const toast = document.querySelector('.toast--error')!;
  expect(toast.getAttribute('role')).toBe('alert');
  expect(toast.querySelector('.toast-message')?.textContent).toBe('Username, email or password is incorrect.');
  expect(document.getElementById('login-password')?.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById('login-email')?.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement?.id).toBe('login-password');
  type('login-password', 'retyped');
  expect(document.getElementById('login-password')?.hasAttribute('aria-invalid')).toBe(false);
});
