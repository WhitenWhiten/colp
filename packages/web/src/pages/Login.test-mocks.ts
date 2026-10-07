/**
 * Leaf module holding the mock instances shared by the Login page suites.
 * vi.mock factories import this file, never Login.test-helper.tsx.
 */
import { vi } from 'vitest'

export const mocks = {
  auth: {
    user: null as { name: string } | null,
    isLoggedIn: false,
    bootstrapping: false,
    csrfToken: null as string | null,
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  toast: {
    toast: vi.fn<(msg: string, variant?: string) => void>(),
    success: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  },
  authClient: {
    signInWithPassword: vi.fn(),
    signUpWithPassword: vi.fn(),
    sendOtp: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyEmailWithOtp: vi.fn(),
    sendVerificationEmail: vi.fn(),
    verifyEmail: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    requestForgetPasswordOtp: vi.fn(),
    resetPasswordWithOtp: vi.fn(),
    startOAuth: vi.fn(),
    requestPasswordRecovery: vi.fn(),
    recoverWithOtp: vi.fn(),
  },
}
