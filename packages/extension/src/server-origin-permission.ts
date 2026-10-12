/** Match pattern for one saved server origin. Optional host permissions cover any https or http host; the request is this origin only. */
export function serverOriginPermissionPattern(origin: string): string {
  return `${new URL(origin).origin}/*`;
}

/** Starts the optional-host prompt. Call it in the save gesture, before any await. */
export function requestServerOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [serverOriginPermissionPattern(origin)] });
}

/** Drops the optional grant for one server origin. Disconnect (D7) calls this. Required Know-N host permissions are not removed. */
export function releaseServerOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: [serverOriginPermissionPattern(origin)] });
}
