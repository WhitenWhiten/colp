function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.padding = '0'
  textarea.style.border = '0'
  textarea.style.opacity = '0'
  const active = document.activeElement
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  textarea.remove()
  if (active instanceof HTMLElement) active.focus()
  return ok
}

/**
 * Copy text from a user gesture. Clipboard API is preferred in a secure
 * context; execCommand is used when the API is missing, insecure (LAN HTTP),
 * or rejected after the async permission check.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const secure = typeof window === 'undefined' || window.isSecureContext

  if (!secure || !clipboard?.writeText) {
    if (copyWithExecCommand(text)) return
    if (clipboard?.writeText) {
      await clipboard.writeText(text)
      return
    }
    throw new Error('Clipboard unavailable')
  }

  try {
    await clipboard.writeText(text)
  } catch {
    if (!copyWithExecCommand(text)) throw new Error('Clipboard unavailable')
  }
}
