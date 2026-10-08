import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Enabled items inside a role="menu" panel — the roaming set shared by
    useAnchoredMenu and every anchored dropdown. Menuitems may also be
    menuitemradio / menuitemcheckbox controls. */
export const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

export function menuItemsOf(menuEl: HTMLElement): HTMLElement[] {
  return Array.from(menuEl.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  )
}

const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

/** The next element in document order that Tab would reach after `from`
    (skipping tabindex="-1", hidden and inert subtrees). R15-35: a menu
    that closes on Tab hands focus here instead of dropping it on <body>. */
export function nextTabbableAfter(from: HTMLElement, exclude?: HTMLElement | null): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)) {
    if (el === from || from.contains(el) || exclude?.contains(el)) continue
    if (!(from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
    if (el.tabIndex < 0 || el.closest('[inert], [hidden], [aria-hidden="true"]')) continue
    if (el.getClientRects().length === 0) continue
    return el
  }
  return null
}

/** Anchors activate on Enter only; APG menuitems must also activate on
    Space (the sibling <button role="menuitem">s get that natively). */
export function onMenuLinkKeyDown(event: ReactKeyboardEvent<HTMLAnchorElement>) {
  if (event.key !== ' ') return
  event.preventDefault()
  event.currentTarget.click()
}
