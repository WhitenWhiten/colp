const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const INVALID_HEADER_VALUE_CHARACTER_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u;
const MAX_HEADER_VALUE_LENGTH = 16 * 1024;

export type PublicationVaryValue = string | readonly string[];

/** Merge required field names into an existing Vary value without losing caller fields. */
export function mergePublicationVary(
  value: PublicationVaryValue | undefined,
  requiredFields: readonly string[],
): string | undefined {
  const fields = value === undefined ? [] : normalizeRepeatedVary(value);
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    for (const part of field.split(',')) addVaryToken(part, tokens, seen);
  }

  if (seen.has('*')) {
    if (seen.size !== 1) throw new TypeError('Vary wildcard cannot be combined with field-name tokens.');
    return '*';
  }

  for (const field of requiredFields) {
    if (typeof field !== 'string' || field === '*' || !HEADER_TOKEN_PATTERN.test(field)) {
      throw new TypeError('Required Vary fields must be HTTP field-name tokens.');
    }
    const identity = field.toLowerCase();
    if (!seen.has(identity)) {
      seen.add(identity);
      tokens.push(field);
    }
  }

  return tokens.length === 0 ? undefined : tokens.join(', ');
}

function addVaryToken(part: string, tokens: string[], seen: Set<string>): void {
  const token = trimOws(part);
  if (token.length === 0 || (token !== '*' && !HEADER_TOKEN_PATTERN.test(token))) {
    throw new TypeError('Vary must contain only non-empty HTTP field-name tokens.');
  }
  const identity = token.toLowerCase();
  if (!seen.has(identity)) {
    seen.add(identity);
    tokens.push(token);
  }
}

function normalizeRepeatedVary(value: PublicationVaryValue): readonly string[] {
  const fields = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new TypeError('Vary must be a string or a non-empty array of strings.');
  }
  let combinedLength = 0;
  for (const field of fields) {
    if (
      typeof field !== 'string'
      || field.length === 0
      || field.length > MAX_HEADER_VALUE_LENGTH
      || INVALID_HEADER_VALUE_CHARACTER_PATTERN.test(field)
    ) {
      throw new TypeError('Vary contains an invalid HTTP header field value.');
    }
    combinedLength += field.length;
    if (combinedLength > MAX_HEADER_VALUE_LENGTH) {
      throw new RangeError(`Vary must not exceed ${MAX_HEADER_VALUE_LENGTH} characters across repeated fields.`);
    }
  }
  return fields;
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, '');
}
