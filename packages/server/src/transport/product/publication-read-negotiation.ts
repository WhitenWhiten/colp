export interface PublicationReadNegotiationInput {
  readonly accept: string | undefined;
  readonly protocolVersion: string | readonly string[] | undefined;
  readonly mediaType: string;
  readonly version: string;
}

export function negotiatePublicationRead(input: PublicationReadNegotiationInput): boolean {
  if (input.protocolVersion !== undefined && input.protocolVersion !== input.version) return false;
  if (input.accept === undefined || input.accept.trim() === '') return true;
  const ranges = splitHeaderList(input.accept, ',');
  if (ranges === null || ranges.length === 0) return false;
  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const range of ranges) {
    const segments = splitHeaderList(range, ';');
    if (segments === null || segments.length === 0) return false;
    const type = segments[0]!.trim().toLowerCase();
    // RFC 9110 §12.5.1 precedence: the most specific matching media range
    // wins, and equal-specificity ranges resolve to the highest quality.
    // A vendor +json media type is genuinely matched by its exact type,
    // then by application/*, then by */*. application/json is NOT a genuine
    // match for a vendor type; it is retained only as an explicit product
    // compatibility alias for +json representations and ranks below every
    // genuine match so it can never override q=0 on a matching range
    // (e.g. `json;q=1, application/*;q=0` stays 406).
    const specificity = type === input.mediaType
      ? 3
      : type === 'application/*'
        ? 2
        : type === '*/*'
          ? 1
          : type === 'application/json' && input.mediaType.endsWith('+json')
            ? 0
            : -1;
    if (specificity < 0) continue;
    const parameters = new Map<string, { readonly value: string; readonly quoted: boolean }>();
    for (const rawParameter of segments.slice(1)) {
      const parsed = parseMediaParameter(rawParameter);
      if (parsed === null || parameters.has(parsed.name)) return false;
      parameters.set(parsed.name, parsed);
    }
    const quality = parameters.get('q');
    if (quality?.quoted === true || (quality !== undefined && !QUALITY_VALUE.test(quality.value))) return false;
    const version = parameters.get('version');
    if (version !== undefined && version.value !== input.version) continue;
    const numericQuality = quality === undefined ? 1 : Number(quality.value);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = numericQuality;
    } else if (specificity === bestSpecificity) {
      bestQuality = Math.max(bestQuality, numericQuality);
    }
  }
  return bestQuality > 0;
}

const MEDIA_PARAMETER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MEDIA_PARAMETER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const QUALITY_VALUE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u;

function splitHeaderList(value: string, separator: ',' | ';'): string[] | null {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === separator) {
      const item = value.slice(start, index).trim();
      if (item === '') return null;
      result.push(item);
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  const finalItem = value.slice(start).trim();
  if (finalItem === '') return null;
  result.push(finalItem);
  return result;
}

function parseMediaParameter(
  value: string,
): { readonly name: string; readonly value: string; readonly quoted: boolean } | null {
  const separator = value.indexOf('=');
  if (separator <= 0) return null;
  const name = value.slice(0, separator).trim().toLowerCase();
  const rawValue = value.slice(separator + 1).trim();
  if (!MEDIA_PARAMETER_NAME.test(name) || rawValue === '') return null;
  if (!rawValue.startsWith('"')) {
    return MEDIA_PARAMETER_TOKEN.test(rawValue) ? { name, value: rawValue, quoted: false } : null;
  }
  if (!rawValue.endsWith('"') || rawValue.length < 2) return null;
  let decoded = '';
  for (let index = 1; index < rawValue.length - 1; index += 1) {
    const character = rawValue[index]!;
    if (character === '\\') {
      index += 1;
      if (index >= rawValue.length - 1) return null;
      decoded += rawValue[index]!;
      continue;
    }
    if (character === '"' || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) return null;
    decoded += character;
  }
  return { name, value: decoded, quoted: true };
}
