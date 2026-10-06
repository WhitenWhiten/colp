import { problemRegistry, type ProblemCode } from '../shared/problems.js';
import type { SemanticValidationResult } from '../semantic/index.js';
import type { Problem } from '../types/index.js';

const MAX_CONTENT_TYPE_LENGTH = 1_024;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/u;

export interface PublicationProblemSemanticContext {
  readonly httpStatus: number;
  readonly contentType: string | null;
}

export interface PublicationProblemRecovery {
  readonly currentRevision?: string;
  readonly currentEtag?: string;
  readonly expectedSequence?: number;
  readonly supportedVersions?: readonly string[];
  readonly retryAfterSeconds?: number;
  readonly snapshotUrl?: string;
  readonly conflictId?: string;
  readonly errors?: readonly Readonly<PublicationProblemFieldError>[];
  readonly links?: Readonly<Record<string, string>>;
}

export interface PublicationProblemFieldError {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface PublicationProblemClassification {
  readonly code: string;
  readonly status: number;
  readonly known: boolean;
  readonly retryable: boolean | undefined;
  readonly recovery: Readonly<PublicationProblemRecovery>;
}

/** Publication semantic checks run only after canonical Problem schema/format validation. */
export function validatePublicationProblemSemantics(
  problem: Problem,
  context: PublicationProblemSemanticContext,
): SemanticValidationResult {
  const issue = validateProblemContentType(context.contentType)
    ?? (problem.status === context.httpStatus
      ? undefined
      : semanticIssue('problem_status_mismatch', '/status', 'Problem status does not match the HTTP response status.'))
    ?? validateRegisteredProblem(problem);
  return issue === undefined
    ? Object.freeze({ valid: true, issues: [] as const })
    : Object.freeze({ valid: false, issues: Object.freeze([Object.freeze(issue)]) });
}

/** Extracts only machine-readable routing and recovery data; title/detail are never consulted. */
export function classifyPublicationProblem(problem: Problem): PublicationProblemClassification {
  const known = isProblemCode(problem.code);
  const registeredCode = known ? problem.code as ProblemCode : undefined;
  const recovery: PublicationProblemRecovery = {
    ...(problem.currentRevision === undefined ? {} : { currentRevision: problem.currentRevision }),
    ...(problem.currentEtag === undefined ? {} : { currentEtag: problem.currentEtag }),
    ...(problem.expectedSequence === undefined ? {} : { expectedSequence: problem.expectedSequence }),
    ...(problem.supportedVersions === undefined
      ? {}
      : { supportedVersions: Object.freeze([...problem.supportedVersions]) }),
    ...(problem.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: problem.retryAfterSeconds }),
    ...(problem.snapshotUrl === undefined ? {} : { snapshotUrl: problem.snapshotUrl }),
    ...(problem.conflictId === undefined ? {} : { conflictId: problem.conflictId }),
    ...(problem.errors === undefined
      ? {}
      : { errors: Object.freeze(problem.errors.map((error) => Object.freeze({ ...error }))) }),
    ...(problem.links === undefined ? {} : { links: Object.freeze({ ...problem.links }) }),
  };
  return Object.freeze({
    code: problem.code,
    status: problem.status,
    known,
    retryable: registeredCode === undefined ? problem.retryable : problemRegistry[registeredCode].retryable,
    recovery: Object.freeze(recovery),
  });
}

function validateRegisteredProblem(problem: Problem): ReturnType<typeof semanticIssue> | undefined {
  if (!isProblemCode(problem.code)) {
    if (problem.code.length > 2_048 || !/^[\x21-\x7e]+$/u.test(problem.code)) {
      return semanticIssue(
        'problem_extension_code_invalid',
        '/code',
        'Extension Problem code must be a bounded visible-ASCII HTTPS namespace URI.',
      );
    }
    let url: URL;
    try {
      url = new URL(problem.code);
    } catch {
      return semanticIssue(
        'problem_extension_code_invalid',
        '/code',
        'Extension Problem code must be a bounded visible-ASCII HTTPS namespace URI.',
      );
    }
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') {
      return semanticIssue(
        'problem_extension_code_invalid',
        '/code',
        'Extension Problem code must be a bounded visible-ASCII HTTPS namespace URI.',
      );
    }
    return undefined;
  }
  const definition = problemRegistry[problem.code];
  if (problem.status !== definition.status) {
    return semanticIssue(
      'problem_registry_status_mismatch',
      '/status',
      'Problem status does not match the registered status for its code.',
    );
  }
  if (problem.retryable !== undefined && problem.retryable !== definition.retryable) {
    return semanticIssue(
      'problem_registry_retryable_mismatch',
      '/retryable',
      'Problem retryable does not match the registered recovery policy for its code.',
    );
  }
  return undefined;
}

function validateProblemContentType(contentType: string | null): ReturnType<typeof semanticIssue> | undefined {
  if (contentType === null) {
    return semanticIssue('problem_content_type_missing', '', 'Problem response is missing Content-Type.');
  }
  if (contentType.length === 0 || contentType.length > MAX_CONTENT_TYPE_LENGTH || /[\r\n]/u.test(contentType)) {
    return semanticIssue('problem_content_type_invalid', '', 'Problem response has an invalid Content-Type.');
  }

  let offset = 0;
  const readToken = (): string | undefined => {
    const match = HTTP_TOKEN.exec(contentType.slice(offset));
    if (match === null) return undefined;
    offset += match[0].length;
    return match[0];
  };
  const skipWhitespace = (): void => {
    while (contentType[offset] === ' ' || contentType[offset] === '\t') offset += 1;
  };
  const type = readToken();
  if (type === undefined || contentType[offset] !== '/') {
    return semanticIssue('problem_content_type_invalid', '', 'Problem response has an invalid Content-Type.');
  }
  offset += 1;
  const subtype = readToken();
  if (type.toLowerCase() !== 'application' || subtype?.toLowerCase() !== 'problem+json') {
    return semanticIssue(
      'problem_content_type_mismatch',
      '',
      'Problem response Content-Type must be application/problem+json.',
    );
  }

  skipWhitespace();
  const parameterNames = new Set<string>();
  while (offset < contentType.length) {
    if (contentType[offset] !== ';') {
      return semanticIssue('problem_content_type_ambiguous', '', 'Problem response Content-Type is ambiguous or invalid.');
    }
    offset += 1;
    skipWhitespace();
    const parameterName = readToken()?.toLowerCase();
    if (parameterName === undefined) {
      return semanticIssue('problem_content_type_invalid', '', 'Problem response has an invalid Content-Type parameter.');
    }
    if (parameterNames.has(parameterName)) {
      return semanticIssue('problem_content_type_ambiguous', '', 'Problem response has a duplicate Content-Type parameter.');
    }
    parameterNames.add(parameterName);
    skipWhitespace();
    if (contentType[offset] !== '=') {
      return semanticIssue('problem_content_type_invalid', '', 'Problem response has an invalid Content-Type parameter.');
    }
    offset += 1;
    skipWhitespace();
    let parameterValue: string;
    if (contentType[offset] === '"') {
      offset += 1;
      let closed = false;
      let value = '';
      while (offset < contentType.length) {
        const character = contentType[offset];
        if (character === '"') {
          offset += 1;
          closed = true;
          break;
        }
        if (character === '\\') {
          offset += 1;
          if (offset >= contentType.length || isInvalidQuotedCharacter(contentType[offset]!)) break;
          value += contentType[offset];
        } else if (character === undefined || isInvalidQuotedCharacter(character)) {
          break;
        } else {
          value += character;
        }
        offset += 1;
      }
      if (!closed) {
        return semanticIssue('problem_content_type_invalid', '', 'Problem response has an invalid quoted parameter.');
      }
      parameterValue = value;
    } else {
      const value = readToken();
      if (value === undefined) {
        return semanticIssue(
          'problem_content_type_invalid',
          '',
          'Problem response has an invalid Content-Type parameter value.',
        );
      }
      parameterValue = value;
    }
    if (parameterName === 'charset' && parameterValue.toLowerCase() !== 'utf-8') {
      return semanticIssue(
        'problem_content_type_charset',
        '',
        'Problem response Content-Type charset must be UTF-8.',
      );
    }
    skipWhitespace();
  }
  return undefined;
}

function isInvalidQuotedCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (codePoint < 0x20 && character !== '\t') || codePoint === 0x7f;
}

function isProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(problemRegistry, code);
}

function semanticIssue(code: string, path: string, message: string): {
  readonly code: string;
  readonly path: string;
  readonly message: string;
} {
  return { code, path, message };
}
