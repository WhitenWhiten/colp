let device: Promise<string> | undefined;

/** Browser identity shared by capture history and source destination bindings. */
export function captureDeviceId(): Promise<string> {
  device ??= (async () => {
    const key = 'known.capture.device.v1', value = (await chrome.storage.local.get(key))[key];
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value)) return value;
    const id = crypto.randomUUID(); await chrome.storage.local.set({ [key]: id }); return id;
  })().catch(error => { device = undefined; throw error; });
  return device;
}
