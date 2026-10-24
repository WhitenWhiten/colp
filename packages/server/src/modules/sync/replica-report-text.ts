/**
 * Display text in a replica report is a bookmark title the owner already keeps
 * in this library, shown back to them in the Sync center. Ordinary words and
 * plain web addresses are fine ("Secret Santa 2026", "OAuth 2.0 Authorization
 * Code Flow", "Chrome: tips", and the address Chrome uses as the title of an
 * untitled bookmark). What must not travel into a report row is a credential,
 * so this recognises credentials by shape instead of by the words that often
 * sit near them:
 *
 * - a password or user name inside an address (`scheme://user:pass@host`);
 * - a secret-looking query or fragment parameter (`?token=…`, `&api_key=…`);
 * - a bearer token, an `Authorization:` header value, a `password=…` pair;
 * - a JWT, a well-known API key prefix, or a long opaque mixed-case run;
 * - a browser-native identity (`native id 42`) or script address (`javascript:alert(1)`).
 *
 * A title that matches is dropped, never stored; the Sync center then shows
 * its generic label for the item.
 */
const SECRET_PARAMETER = '(?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|auth|authorization|api[_-]?key|apikey|'
  + 'key|secret|client[_-]?secret|password|passwd|pwd|sig|signature|session|session[_-]?id|sid|jwt|bearer|credential|otp)';
const SECRET_WORD = '(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)';

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // `https://user:pass@host`, `https://ghp_token@github.com`: anything before an `@` in the authority.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*@/iu,
  // `?token=abc123`, `&api_key=…`, `#access_token=…`
  new RegExp(`(?:^|[?&#;\\s])${SECRET_PARAMETER}=[^&\\s#]{6,}`, 'iu'),
  // `Bearer eyJ…`; the bare word is an ordinary word.
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  // `Authorization: Basic dXNlcjpwYXNz`, `authorization=abcdef…`
  /\bauthorization\s*[:=]\s*(?:(?:basic|bearer|token|digest|negotiate|apikey)\s+)?[A-Za-z0-9._~+/=-]{8,}/iu,
  // `password: hunter2`, `token=abc123`; a value needs a digit or enough length to look like one.
  new RegExp(`\\b${SECRET_WORD}\\s*[:=]\\s*(?=\\S*\\d|\\S{16,})\\S{4,}`, 'iu'),
  // JSON web token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/u,
  // well-known key prefixes: Stripe, GitHub, AWS, Slack, Google
  /\b(?:[sprw]k_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/u,
  // a browser-native identity, and an address that runs script
  /\bnative[_ -]?id\b\s*[:=#]?\s*\d+/iu,
  /\bjavascript:\S/iu,
];

/** A long run that mixes cases and digits is an opaque token (a slug in one case is not). */
function hasOpaqueRun(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9+/_=-]{32,}/gu) ?? []) {
    if (/\d/u.test(run) && /[a-z]/u.test(run) && /[A-Z]/u.test(run)) return true;
  }
  return false;
}

/** Whether a title may be stored and shown with a replica report. */
export function replicaReportTextIsSafe(text: string): boolean {
  return !CREDENTIAL_SHAPES.some((shape) => shape.test(text)) && !hasOpaqueRun(text);
}
