/** Canonicalizes the media-type request dimension without altering quoted OWS. */
export function normalizePublisherMediaType(value: string): string {
  if (typeof value !== 'string' || value.length === 0
    || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Publisher request mediaType is invalid.');
  }
  let normalized = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      normalized += character.toLowerCase();
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      normalized += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && (character === ' ' || character === '\t')) continue;
    normalized += character.toLowerCase();
  }
  const mediaTypePattern = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+(?:;[!#$%&'*+.^_`|~0-9a-z-]+=(?:[!#$%&'*+.^_`|~0-9a-z-]+|"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"))*$/u;
  if (quoted || escaped || !mediaTypePattern.test(normalized)) {
    throw new TypeError('Publisher request mediaType is invalid.');
  }
  return normalized;
}
