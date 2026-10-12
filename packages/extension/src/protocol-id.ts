const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export function isProtocolOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}
