/**
 * Platform-aware label for the site search shortcut. The keydown handlers
 * accept both metaKey and ctrlKey everywhere; this only controls what the
 * UI advertises: ⌘K on Apple platforms, Ctrl K elsewhere.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform ?? ''
  const userAgent = navigator.userAgent ?? ''
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac|iPhone|iPad|iPod/i.test(userAgent)
}

export function searchShortcutLabel(): string {
  return isApplePlatform() ? '⌘K' : 'Ctrl K'
}
