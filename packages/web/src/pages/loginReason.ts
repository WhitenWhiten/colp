export const LOGIN_REASON_APPROVAL_REQUIRED = 'approval_required'

const LOGIN_REASON_MESSAGES: Readonly<Record<string, string>> = {
  [LOGIN_REASON_APPROVAL_REQUIRED]: 'Please sign in before authorizing this MCP change.',
}

/** Only known application intents may create sign-in feedback. */
export function loginReasonMessage(raw: string | null): string | null {
  if (!raw || !Object.prototype.hasOwnProperty.call(LOGIN_REASON_MESSAGES, raw)) return null
  return LOGIN_REASON_MESSAGES[raw] ?? null
}
