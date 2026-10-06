/**
 * Read whole attributes without searching again at every whitespace position.
 * Quoted HREF text inside another attribute never acquires bookmark authority.
 */
export function readNetscapeBookmarkHref(attributes: string): string | undefined {
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/uy;
  let cursor = 0;
  while (cursor < attributes.length) {
    if (cursor > 0 && !/\s/u.test(attributes[cursor]!)) {
      throw new TypeError('Malformed Netscape bookmark attributes.');
    }
    while (cursor < attributes.length && /\s/u.test(attributes[cursor]!)) cursor += 1;
    if (cursor === attributes.length) break;
    pattern.lastIndex = cursor;
    const match = pattern.exec(attributes);
    if (match === null) throw new TypeError('Malformed Netscape bookmark attribute.');
    cursor = pattern.lastIndex;
    if (match[1]!.toLowerCase() === 'href') return match[2] ?? match[3] ?? match[4];
  }
  return undefined;
}
