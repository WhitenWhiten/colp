import { useState, type InputHTMLAttributes } from 'react'
import { Icon } from '../Icon'

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

/** Mirrors Known-Backend better-auth-runtime.ts `minPasswordLength`. */
export const MIN_PASSWORD_LENGTH = 8

/** Password input with a show/hide toggle. Visual language matches Login. */
export function PasswordField({ disabled, ...props }: PasswordFieldProps) {
  const [show, setShow] = useState(false)
  return (
    <div className="auth-otp-row auth-password-row">
      <input {...props} type={show ? 'text' : 'password'} disabled={disabled} />
      <button
        type="button"
        className="btn btn-ghost auth-otp-send"
        aria-label={show ? 'Hide password' : 'Show password'}
        disabled={disabled}
        onClick={() => setShow((v) => !v)}
      >
        <Icon name={show ? 'eye-off' : 'eye'} />
      </button>
    </div>
  )
}
