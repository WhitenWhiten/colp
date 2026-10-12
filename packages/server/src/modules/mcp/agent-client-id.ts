/** OAuth client IDs can be opaque registrations or HTTPS CIMD metadata URLs. */
export function isAgentClientId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^[A-Za-z0-9._~-]{1,256}$/u.test(value)) return true;
  if (!/^https:\/\//iu.test(value) || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== ''
      && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
}
