/** The adapter boundary is qualified on Chromium 149+. Ordinary saving keeps its own minimum. */
export const MIN_ADAPTER_CHROME = 149;
export function adapterBrowserSupport(userAgent: string) {
  const match = /(?:Chrome|Chromium)\/(\d+)\./u.exec(userAgent), major = match ? Number(match[1]) : null;
  return { minimum: MIN_ADAPTER_CHROME, major, supported: major !== null && major >= MIN_ADAPTER_CHROME,
    unsupportedRange: 'Chrome 121–148; other engines are unqualified' };
}
