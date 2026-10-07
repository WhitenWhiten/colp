export const INTERNAL_NAVIGATION_REQUEST = 'known:internal-navigation-request'

export function requestInternalNavigation(): boolean {
  return window.dispatchEvent(new Event(INTERNAL_NAVIGATION_REQUEST, { cancelable: true }))
}
