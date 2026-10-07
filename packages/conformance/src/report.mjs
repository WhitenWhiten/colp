/**
 * The checks the runner performs, keyed by requirement ID from
 * protocol/requirements.yaml, and the report that aggregates observations.
 *
 * A check fails when any observation fails. MUST / MUST_NOT failures are
 * `fail`; SHOULD / MAY failures are `warn`. A check with no observations is
 * `skip`, with the reason the runner gave.
 */

export const CHECKS = Object.freeze([
  { id: 'PUB-0011', level: 'MUST', title: 'Manifest is served at /.well-known/collection-protocol' },
  { id: 'PUB-0012', level: 'MUST', title: 'Each mount declares profiles, endpoints, auth, and limits' },
  { id: 'PUB-0003', level: 'MUST', title: 'Manifest semantics: absolute Level 1 endpoint templates, known profiles' },
  { id: 'PUB-0001', level: 'MUST', title: 'Publication mounts declare directory, collection, and snapshot endpoints' },
  { id: 'PUB-0028', level: 'MUST', title: 'Mount baseUrl ends with "/"' },
  { id: 'PUB-0016', level: 'MUST', title: 'Responses are UTF-8' },
  { id: 'PUB-0017', level: 'MUST', title: 'Responses are I-JSON (no duplicate members, safe numbers)' },
  { id: 'PUB-0018', level: 'MUST', title: 'Response bodies validate against their named $defs' },
  { id: 'CORE-0001', level: 'MUST', title: 'Snapshots pass semantic validation (root, identity, graph, positions, references)' },
  { id: 'PUB-0033', level: 'MUST', title: 'Snapshot pages share snapshotId, revision, and mode' },
  { id: 'PUB-0040', level: 'MUST', title: 'Publication Bookmark URLs are absolute http(s) URLs without userinfo' },
  { id: 'PUB-0009', level: 'MUST', title: 'The anonymous Directory lists only public Collections' },
  { id: 'PUB-0010', level: 'MUST', title: 'Unknown and duplicate scalar query parameters return 400 invalid_query' },
  { id: 'PUB-0008', level: 'MUST', title: 'Errors are RFC 9457 Problem Details with a registered code' },
  { id: 'PUB-0024', level: 'MUST', title: 'Negotiated responses vary by Accept and Collection-Protocol-Version' },
  { id: 'PUB-0020', level: 'SHOULD', title: 'Servers return the versioned COLP media types' },
  { id: 'PUB-0021', level: 'SHOULD', title: 'GET responses carry ETag and Last-Modified' },
  { id: 'PUB-0022', level: 'SHOULD', title: 'If-None-Match is answered with 304 Not Modified' },
  { id: 'PUB-0027', level: 'SHOULD', title: 'The Manifest is publicly cacheable with an ETag' },
  { id: 'PUB-0032', level: 'SHOULD', title: 'Collection Metadata sends Link headers for self, canonical, and snapshot' },
  { id: 'PUB-0034', level: 'SHOULD', title: 'Paginated Snapshots send Link rel="next"' },
].map((check) => Object.freeze(check)));

const byId = new Map(CHECKS.map((check) => [check.id, check]));
const MAX_DETAILS = 5;
// Strip terminal protocols (CSI/OSC and the short two-byte forms) and render
// remaining control characters visibly. Report details include server-owned
// URLs, headers, and parser messages, so sanitizing at the report boundary
// protects both the text renderer and callers that log `report` directly.
const ANSI_ESCAPE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/gu;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/gu;

export function sanitizeTerminalText(value) {
  return String(value)
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARACTER, (character) => {
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === '\t') return '\\t';
      return `\\x${character.codePointAt(0).toString(16).padStart(2, '0')}`;
    });
}

export class Report {
  #observations = new Map(CHECKS.map((check) => [check.id, { passed: 0, failures: [], skipReason: undefined }]));
  #notes = [];

  constructor(target) {
    this.target = sanitizeTerminalText(target);
  }

  /** Records one observation for a check. `detail` explains a failure. */
  record(id, ok, detail) {
    const entry = this.#entry(id);
    if (ok) {
      entry.passed += 1;
    } else {
      entry.failures.push(detail === undefined ? 'failed' : sanitizeTerminalText(detail));
    }
    return ok;
  }

  /** Marks why a check could not be observed; ignored once it has observations. */
  skip(id, reason) {
    const entry = this.#entry(id);
    entry.skipReason ??= reason;
  }

  /** Gives every check that has no observations or reason yet the same skip reason. */
  skipRemaining(reason) {
    for (const entry of this.#observations.values()) {
      if (entry.passed === 0 && entry.failures.length === 0) entry.skipReason ??= reason;
    }
  }

  /** Adds a run-level note, such as stopping early. */
  note(text) {
    this.#notes.push(sanitizeTerminalText(text));
  }

  finish(requestCount) {
    const results = CHECKS.map((check) => {
      const { passed, failures, skipReason } = this.#observations.get(check.id);
      let status = 'pass';
      if (failures.length > 0) status = check.level.startsWith('MUST') ? 'fail' : 'warn';
      else if (passed === 0) status = 'skip';
      const details = status === 'skip'
        ? [skipReason ?? 'not observed']
        : failures.slice(0, MAX_DETAILS);
      if (failures.length > MAX_DETAILS) details.push(`... and ${failures.length - MAX_DETAILS} more`);
      return Object.freeze({ ...check, status, observations: passed + failures.length, details });
    });
    const summary = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const result of results) summary[result.status] += 1;
    return Object.freeze({ target: this.target, requestCount, summary, results, notes: [...this.#notes] });
  }

  #entry(id) {
    if (!byId.has(id)) throw new TypeError(`Unknown conformance check ${id}`);
    return this.#observations.get(id);
  }
}

/** Renders a report as aligned plain text for a terminal. */
export function formatReport(report) {
  const lines = [
    'COLP conformance: core + publication (anonymous, read-only)',
    `Target: ${sanitizeTerminalText(report.target)}`,
    '',
  ];
  for (const result of report.results) {
    lines.push(`  ${sanitizeTerminalText(result.status.toUpperCase().padEnd(4))}  ${sanitizeTerminalText(result.id.padEnd(9))} ${sanitizeTerminalText(result.level.padEnd(6))}  ${sanitizeTerminalText(result.title)}`);
    if (result.status !== 'pass') {
      for (const detail of result.details) lines.push(`          ${sanitizeTerminalText(detail)}`);
    }
  }
  for (const note of report.notes) lines.push('', `Note: ${sanitizeTerminalText(note)}`);
  const { pass, fail, warn, skip } = report.summary;
  lines.push('', `${pass} passed, ${fail} failed, ${warn} warnings, ${skip} skipped (${report.requestCount} requests)`);
  return lines.join('\n');
}
