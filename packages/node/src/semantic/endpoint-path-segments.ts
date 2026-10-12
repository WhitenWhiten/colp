import { parseTemplate } from 'url-template';

/**
 * Pre-dispatch guard for endpoint template expansion.
 *
 * Opaque wire IDs may legally be `.` or `..` (see the canonical resource URI,
 * which uses a `~` sentinel for exactly this reason). WHATWG URL parsing
 * removes single-dot and double-dot path segments, including their `%2e`
 * spellings, so expanding such an ID as a whole path segment would silently
 * address a different resource on the same origin. Percent-encoding cannot
 * help because `%2e` is itself a dot segment.
 *
 * The guard is location-sensitive: it rejects an expansion only when a path
 * segment that contains expanded variable output becomes a dot segment.
 * Query-bound IDs (`?id={id}`), sentinel layouts (`/c/~{id}`,
 * `/c/{id}.json`), interior dots (`a.b`) and literal template text are not
 * affected, and the opaque-ID grammar itself is unchanged.
 */
export function assertEndpointExpansionKeepsPathSegments(
  template: string,
  values: Readonly<Record<string, string>>,
): void {
  const offending = dotSegmentVariables(template, values);
  if (offending.length > 0) {
    throw new TypeError(
      `Endpoint variable ${offending.join(', ')} would expand to a "." or ".." path segment `
        + 'that URL normalization removes; such IDs need a query or sentinel-bound endpoint template.',
    );
  }
}

interface ExpressionRange {
  readonly start: number;
  readonly end: number;
  readonly names: readonly string[];
}

const expression = /\{([^{}]*)\}/gu;
const schemeAndAuthority = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[/\\]{2}[^/\\?#]*)?/u;
const dotSegments = new Set(['.', '%2e', '..', '.%2e', '%2e.', '%2e%2e']);

function dotSegmentVariables(template: string, values: Readonly<Record<string, string>>): readonly string[] {
  // Expand expression by expression so every expanded character is
  // attributable; Level 1 expansion of the whole template is identical.
  let expanded = '';
  const ranges: ExpressionRange[] = [];
  let literalStart = 0;
  for (const match of template.matchAll(expression)) {
    expanded += template.slice(literalStart, match.index);
    const output = parseTemplate(match[0]).expand(values);
    ranges.push({
      start: expanded.length,
      end: expanded.length + output.length,
      names: (match[1] ?? '').split(',').map((name) => name.replace(/^[+#./;?&]/u, '').replace(/[:*].*$/u, '')),
    });
    expanded += output;
    literalStart = match.index + match[0].length;
  }
  expanded += template.slice(literalStart);
  if (ranges.length === 0) return [];

  const pathStart = schemeAndAuthority.exec(expanded)?.[0].length ?? 0;
  const queryOrFragment = expanded.slice(pathStart).search(/[?#]/u);
  const pathEnd = queryOrFragment === -1 ? expanded.length : pathStart + queryOrFragment;

  const offending = new Set<string>();
  let segmentStart = pathStart;
  for (let index = pathStart; index <= pathEnd; index += 1) {
    const character = expanded[index];
    if (index < pathEnd && character !== '/' && character !== '\\') continue;
    const segment = expanded.slice(segmentStart, index);
    if (dotSegments.has(segment.toLowerCase())) {
      for (const range of ranges) {
        if (range.start <= index && range.end >= segmentStart) range.names.forEach((name) => offending.add(name));
      }
    }
    segmentStart = index + 1;
  }
  return [...offending].sort();
}
