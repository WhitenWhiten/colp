export interface NetscapeBookmarkTag {
  readonly closing: boolean;
  readonly tag: 'DL' | 'H3' | 'A';
  readonly attributes: string;
  readonly text: string;
}

/** A monotonically advancing, quote-aware scanner over an already bounded input. */
export function* scanNetscapeBookmarkTags(input: string): Generator<NetscapeBookmarkTag> {
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('<', cursor);
    if (start === -1) return;
    if (input.startsWith('<!--', start)) {
      const end = input.indexOf('-->', start + 4);
      if (end === -1) throw new TypeError('Unterminated Netscape bookmark comment.');
      cursor = end + 3;
      continue;
    }
    let end = start + 1;
    let quote: string | undefined;
    for (; end < input.length; end += 1) {
      const character = input[end];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    // Do not retry a greedy regular expression at every embedded '<H3'.
    if (end === input.length) throw new TypeError('Unterminated Netscape bookmark tag.');
    const match = /^(\/?)(DL|H3|A)\b([\s\S]*)$/iu.exec(input.slice(start + 1, end));
    const textStart = end + 1;
    const next = input.indexOf('<', textStart);
    cursor = next === -1 ? input.length : next;
    if (match !== null) {
      yield {
        closing: match[1] === '/',
        tag: match[2]!.toUpperCase() as NetscapeBookmarkTag['tag'],
        attributes: match[3] ?? '',
        text: input.slice(textStart, cursor),
      };
    }
  }
}
