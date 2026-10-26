/** GET uses weak comparison. Ignore malformed validators rather than accepting a partial match. */
export function matchesImageEtag(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  if (value.trim() === '*') return true;
  const validators: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (value[index] === ',' && !quoted) {
      validators.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) return false;
  validators.push(value.slice(start).trim());
  return validators.every((item) => /^(?:W\/)?"[\x21\x23-\x7E\u0080-\u00FF]*"$/u.test(item))
    && validators.some((item) => item.replace(/^W\//u, '') === etag);
}
