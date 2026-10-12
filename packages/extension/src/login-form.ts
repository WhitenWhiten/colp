import { authErrorCopy } from './auth-error-copy.js';
import { dismissToast, showToast } from './toast.js';
import { t } from './i18n.js';

export const OTP_RESEND_COOLDOWN_SECONDS = 20;
export const OTP_LENGTH = 6;

export type LoginMode = 'password' | 'otp';

export interface LoginFormHandlers {
  signInPassword(email: string, password: string): Promise<void>;
  sendOtp(email: string): Promise<void>;
  signInOtp(email: string, otp: string): Promise<void>;
  startOAuth(provider: 'google' | 'github'): Promise<void>;
}

export function bindLoginForm(handlers: LoginFormHandlers): { setCloudEnabled(enabled: boolean): void } {
  const form = required('login-form') as HTMLFormElement;
  const email = required('login-email') as HTMLInputElement;
  const password = required('login-password') as HTMLInputElement;
  const otp = required('login-otp-code') as HTMLInputElement;
  const sendOtp = required('login-send-otp') as HTMLButtonElement;
  const submit = required('login-submit') as HTMLButtonElement;
  const tabPassword = required('login-tab-password') as HTMLButtonElement;
  const tabOtp = required('login-tab-otp') as HTMLButtonElement;
  const passwordField = required('login-password-field');
  const otpField = required('login-otp-field');
  const google = required('login-google') as HTMLButtonElement;
  const github = required('login-github') as HTMLButtonElement;

  let mode: LoginMode = 'password';
  let busy: 'sign-in' | 'send-otp' | 'oauth' | null = null;
  let cooldown = 0;
  let cooldownTimer: number | undefined;
  let cloudEnabled = true;

  const setMode = (next: LoginMode) => {
    if (next === 'otp' && !cloudEnabled) return;
    mode = next;
    email.type = next === 'otp' ? 'email' : 'text';
    email.autocomplete = next === 'otp' ? 'email' : 'username';
    tabPassword.setAttribute('aria-selected', next === 'password' ? 'true' : 'false');
    tabOtp.setAttribute('aria-selected', next === 'otp' ? 'true' : 'false');
    /* Roving tabindex: only the selected tab is in the tab order. */
    tabPassword.tabIndex = next === 'password' ? 0 : -1;
    tabOtp.tabIndex = next === 'otp' ? 0 : -1;
    if (next === 'password') {
      passwordField.removeAttribute('data-inactive');
      passwordField.removeAttribute('aria-hidden');
      otpField.setAttribute('data-inactive', '');
      otpField.setAttribute('aria-hidden', 'true');
      password.required = true;
      otp.required = false;
      otp.disabled = true;
      password.disabled = busy !== null;
    } else {
      otpField.removeAttribute('data-inactive');
      otpField.removeAttribute('aria-hidden');
      passwordField.setAttribute('data-inactive', '');
      passwordField.setAttribute('aria-hidden', 'true');
      otp.required = true;
      password.required = false;
      password.disabled = true;
      otp.disabled = busy !== null;
    }
    refresh();
  };

  const refresh = () => {
    const emailValue = email.value.trim();
    const canSend = mode === 'otp' && emailValue.length > 0 && cooldown === 0 && busy === null;
    sendOtp.disabled = !canSend;
    sendOtp.textContent = busy === 'send-otp' ? t('common_sending', 'Sending…') : cooldown > 0 ? t('auth_cooldownSeconds', '$1s', cooldown) : t('common_sendCode', 'Send code');
    const canSignIn = busy === null && emailValue.length > 0 && (
      // The server decides whether a password is right; older accounts may have short ones.
      mode === 'password' ? password.value.length > 0
        : new RegExp(`^\\d{${OTP_LENGTH}}$`, 'u').test(otp.value.trim())
    );
    submit.disabled = !canSignIn;
    submit.textContent = busy === 'sign-in' ? t('common_signingIn', 'Signing in…') : t('common_signIn', 'Sign in');
    google.disabled = busy !== null || !cloudEnabled;
    github.disabled = busy !== null || !cloudEnabled;
    tabPassword.disabled = busy !== null;
    tabOtp.disabled = busy !== null || !cloudEnabled;
    email.disabled = busy !== null;
  };

  /* Same channel as the web login: a server-side failure is an error toast
     (auto-dismissing, so the card never resizes and stale copy never
     sticks), and the suspect inputs carry aria-invalid until edited. */
  const markInvalid = (fields: readonly HTMLInputElement[]) => {
    for (const input of [email, password, otp]) {
      if (fields.includes(input)) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  };
  const showError = (message: string, suspect: readonly HTMLInputElement[] = []) => {
    markInvalid(suspect);
    showToast(message, 'error', { announce: true });
  };
  const clearError = () => {
    markInvalid([]);
    dismissToast();
  };

  const startCooldown = () => {
    cooldown = OTP_RESEND_COOLDOWN_SECONDS;
    refresh();
    if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer);
    cooldownTimer = window.setInterval(() => {
      cooldown = Math.max(0, cooldown - 1);
      if (cooldown === 0 && cooldownTimer !== undefined) {
        window.clearInterval(cooldownTimer);
        cooldownTimer = undefined;
      }
      refresh();
    }, 1_000);
  };

  const withBusy = async (kind: typeof busy, work: () => Promise<void>, event: Event) => {
    if (busy !== null) return;
    if (!event.isTrusted || !navigator.userActivation.isActive) {
      showError(t('auth_useButtonStartSign', 'Use the button to start sign-in.'));
      return;
    }
    busy = kind;
    refresh();
    let failed: string | undefined;
    try {
      await work();
      if (kind !== 'send-otp') clearError();
    } catch (error) {
      const code = error instanceof Error ? error.message : undefined;
      // The toast never shows raw codes (R13 E-07); DevTools keeps the one
      // detail a bug report needs.
      console.warn('Know-N sign-in failed:', code ?? 'unknown');
      failed = code;
      showError(authErrorCopy(code, 'attempt'), suspectFields(kind, code));
    } finally {
      busy = null;
      refresh();
    }
    // Inputs are disabled while busy, so focus waits for the settle.
    if (failed !== undefined) suspectFields(kind, failed)[0]?.focus();
  };
  /* Non-enumerating, like the web: a rejected password marks both inputs and
     focuses the password, the usual retype; a rejected code marks the code. */
  const suspectFields = (kind: typeof busy, code: string | undefined): HTMLInputElement[] => {
    if (kind !== 'sign-in' || code !== 'invalid_credentials') return [];
    return mode === 'password' ? [password, email] : [otp];
  };

  tabPassword.addEventListener('click', () => { if (busy === null) setMode('password'); });
  tabOtp.addEventListener('click', () => { if (busy === null) setMode('otp'); });
  /* ARIA tabs keyboard model: arrows/Home/End move selection and focus
     together across the two tabs. */
  const onTabKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (busy !== null) return;
    const next: LoginMode = event.key === 'Home' ? 'password'
      : event.key === 'End' ? 'otp'
        : mode === 'password' ? 'otp' : 'password';
    setMode(next);
    (next === 'password' ? tabPassword : tabOtp).focus();
  };
  tabPassword.addEventListener('keydown', onTabKeydown);
  tabOtp.addEventListener('keydown', onTabKeydown);
  for (const input of [email, password, otp]) input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  email.addEventListener('input', () => refresh());
  password.addEventListener('input', () => refresh());
  otp.addEventListener('input', () => {
    otp.value = otp.value.replace(/\D/gu, '').slice(0, OTP_LENGTH);
    refresh();
  });
  const emailValue = () => email.value.trim().toLowerCase();
  sendOtp.addEventListener('click', (event) => {
    if (!cloudEnabled) return;
    void withBusy('send-otp', async () => {
      const address = emailValue();
      await handlers.sendOtp(address);
      startCooldown();
      markInvalid([]);
      showToast(t('auth_ifAccountExistsSign', 'If an account exists for $1, a sign-in code was sent.', address), 'info', { announce: true });
    }, event);
  });
  google.addEventListener('click', (event) => { if (cloudEnabled) void withBusy('oauth', () => handlers.startOAuth('google'), event); });
  github.addEventListener('click', (event) => { if (cloudEnabled) void withBusy('oauth', () => handlers.startOAuth('github'), event); });
  const submitSignIn = (event: Event) => {
    if (mode === 'password') {
      void withBusy('sign-in', () => handlers.signInPassword(emailValue(), password.value), event);
    } else {
      void withBusy('sign-in', () => handlers.signInOtp(emailValue(), otp.value.trim()), event);
    }
  };
  submit.addEventListener('click', (event) => {
    event.preventDefault();
    submitSignIn(event);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSignIn(event);
  });

  setMode('password');
  refresh();
  return {
    setCloudEnabled(enabled) {
      cloudEnabled = enabled;
      tabOtp.hidden = !enabled;
      google.hidden = !enabled; github.hidden = !enabled;
      for (const id of ['login-social-divider', 'login-social', 'login-registration']) {
        const node = document.getElementById(id); if (node) node.hidden = !enabled;
      }
      const forgot = document.getElementById('login-forgot')?.parentElement;
      if (forgot) forgot.hidden = !enabled;
      const help = document.getElementById('login-password-help');
      if (help) help.hidden = enabled;
      if (!enabled) setMode('password');
      else refresh();
    },
  };
}

export function setLoginProductLinks(origin: string): void {
  const base = origin.replace(/\/$/u, '') || 'https://know-n.com';
  const forgot = document.getElementById('login-forgot') as HTMLAnchorElement | null;
  const register = document.getElementById('login-register') as HTMLAnchorElement | null;
  const email = (document.getElementById('login-email') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  if (forgot) {
    forgot.href = email.includes('@') ? `${base}/reset-password?email=${encodeURIComponent(email)}` : `${base}/reset-password`;
  }
  if (register) register.href = `${base}/register`;
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('login_markup_invalid');
  return value;
}

let shownReason: string | undefined;

/**
 * Why a signed-out/error state ended the session (e.g. binding_mismatch).
 * The web login toasts its sign-out reason; the extension does the same, once
 * per distinct reason, so re-renders of the same state do not re-toast it.
 */
export function announceAuthReason(state: { readonly status: string; readonly errorCode?: string }): void {
  const reason = state.status === 'error' || state.status === 'signed_out' || state.status === 'policy_blocked'
    ? state.errorCode : undefined;
  if (reason === shownReason) return;
  shownReason = reason;
  if (reason) showToast(authErrorCopy(reason), state.status === 'signed_out' ? 'info' : 'error', { announce: true });
}
