/** RFC 3339 UTC date-time with trailing Z (Product UtcDateTime). */
export function formatUtcDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
