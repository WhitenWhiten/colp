/** Shared KNS-08 evidence redaction. No Playwright or Profile management. */
export function redactEvidenceText(text: string, extra: readonly string[] = []): string {
  let next = text
    .replace(/https?:\/\/[^\s"'\\<>]+/giu, '[redacted-url]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted-jwt]')
    .replace(/__Host-known_session=[^;\s]+/gu, '__Host-known_session=[redacted]')
    .replace(/p3-27-extension@example\.test/gu, '[redacted-email]')
    .replace(/p3-27-extension-password-e3/gu, '[redacted-secret]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '[redacted-uuid]');
  for (const marker of extra) {
    if (marker.length >= 4) next = next.split(marker).join('[redacted-marker]');
  }
  return next;
}
