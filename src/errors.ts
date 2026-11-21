/**
 * Errors and redaction.
 *
 * The rule: no text Pleo controls ever reaches a host, a result or an audit
 * record through an error. An HTTP error carries the status, our own hint and
 * the parsed Retry-After; never a response body, an error message from Pleo,
 * or a redirect's Location. Pleo's text can quote the request or part of the
 * key, and no redactor recognises every fragment.
 *
 * Redaction is the second line: the key of the instance in scope (its exact
 * value, its encoded forms and any fragment of FRAGMENT_LENGTH characters or
 * more) is redacted from everything returned, on structured values before
 * they are serialised.
 */
import { redactRegisteredSecrets } from './upstream-http.js';

export { FRAGMENT_LENGTH, MIN_SECRET_LENGTH } from './upstream-http.js';

/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;

export interface PleoHttpErrorInput {
  status: number;
  method: string;
  url: string;
  retryAfter?: string;
  requestId?: string;
}

const SECRET_PATTERNS = [
  // Bearer or Basic, in any case, before a value that holds the marker of an earlier redaction: the scheme word and the
  // whole value up to a space, quote, comma or brace, whatever its length (a short tail after the marker is still part
  // of the credential).
  /\b(bearer|basic)\s+[^\s"',}]*‹redacted›[^\s"',}]*/gi,
  /Authorization:\s*(Bearer|Basic)\s+[^,\s}]+/gi,
  // A credential-named assignment in text: `X-Api-Key: S`, `client_secret=S`, `?api_key=S`, `"accessToken": "S"`.
  /(PLEO_API_KEY|PLEO_ACCESS_TOKEN|(?:x[-_]?)?api[-_]?(?:key|token|secret)|client[-_]?secret|(?:access|refresh|auth|id|session|bearer)[-_]?token|accessToken|apiKey|token|password|passwd|secret)["']?\s*[:=]\s*["']?[^"',\s}&]+/gi,
  // A marker left by the secrets' redaction (‹redacted›) counts as part of a value, so the rest of it is masked too.
  /\b(Bearer|Basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›)+=*/g,
  // Any case ("bearer", "BASIC"), when what follows looks like a token: 8 or more base64 or base64url characters. A
  // short word after "basic" ("basic plan") is left alone; a longer one is masked, a false positive we accept.
  /\b(bearer|basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›){8,}=*/gi,
  // A JSON Web Token anywhere: three base64url segments, the first a JSON header ("eyJ").
  /\beyJ(?:[A-Za-z0-9_-]|‹redacted›)*\.(?:[A-Za-z0-9_-]|‹redacted›)+\.(?:[A-Za-z0-9_-]|‹redacted›)*/g,
];

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  401: 'The Pleo API key was rejected (invalid or revoked).',
  403: 'The Pleo API key has no access to this. Retrying will not help.',
  404: 'Pleo found nothing at this address. Check the ids.',
  429: 'Pleo is throttling requests. Wait and retry later.',
};

/**
 * An HTTP error from Pleo: the status, our own hint and the parsed
 * Retry-After. Nothing of the body is kept. Pleo's request id is kept as a
 * property, only in the form such ids have (see requestIdFrom), never in the
 * message.
 */
export class PleoHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or not a number of seconds. */
  readonly retryAfter?: string;
  /** Pleo's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;

  constructor(input: PleoHttpErrorInput) {
    const retryAfter = wholeNumber(input.retryAfter);
    super(
      [
        `Pleo API request failed with HTTP ${input.status}`,
        Object.hasOwn(STATUS_HINTS, input.status) ? STATUS_HINTS[input.status] : undefined,
        retryAfter === undefined ? undefined : `retry-after=${retryAfter}s`,
      ]
        .filter(Boolean)
        .join(' | '),
    );
    this.name = 'PleoHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.retryAfter = retryAfter;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * A redirect from Pleo, refused (it is never followed): our own text, the status of the answer and its request id,
 * nothing else of the response.
 */
export class PleoRedirectError extends Error {
  readonly status: number;
  /** Pleo's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;

  constructor(message: string, input: { status: number; requestId?: string }) {
    super(message);
    this.name = 'PleoRedirectError';
    this.status = input.status;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first. Pleo's own `pleo-request-id` first, then the
 * common list.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'pleo-request-id',
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Pleo answered with and its
 * request id. Never the response body, the vendor's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of Pleo's answer (100-599). */
  httpStatus: number;
  /** The vendor's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/** The failure metadata of an error: an HTTP error from Pleo (a refused redirect included) gives its status and request id. */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof PleoHttpError) && !(error instanceof PleoRedirectError)) return undefined;
  const status: unknown = error.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

/**
 * Credential-shaped text first, while it is whole: an instance secret replaced inside a Basic value or a token would
 * break the match and leave the rest of the value. Then the instance's secrets, then the patterns again (they also take
 * the marker as part of a value), until nothing changes.
 */
export function redactSecrets(value: string): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactRegisteredSecrets(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * Credential-shaped text replaced by a marker: an Authorization header, a
 * Bearer or Basic value, and `token=`/`apiKey:`-style assignments. Applied to
 * every text a gateway returns, so a credential the upstream echoes (one that
 * is not the instance's own key, such as a session token) never leaves it.
 * Uses no state: the same input always gives the same output.
 */
export function redactCredentialPatterns(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        if (/^eyJ/.test(match)) {
          return '[REDACTED]';
        }

        if (/^(Bearer|Basic)\s/i.test(match)) {
          const scheme = match.split(/\s+/)[0] ?? 'Authorization';
          return `${scheme} [REDACTED]`;
        }

        if (/^Authorization:/i.test(match)) {
          return 'Authorization: [REDACTED]';
        }

        // The first separator ends the name: everything after it is the value, which may itself hold `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} [REDACTED]`;
      }),
    value,
  );
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets. Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactSecrets(text) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
}

/** Copy of parsed JSON with anything nested deeper than MAX_REDACT_DEPTH replaced, so it can be serialised safely. */
export function limitDepth(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => limitDepth(entry, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, limitDepth(entry, depth + 1)]));
}

/** Keys whose value is a failure context: anything inside that carries an error or a message is a failure. */
const FAILURE_CONTEXTS = new Set(['failures', 'failure', 'errors', 'error', 'metadata', 'warnings', 'amount']);
/** Fields that make an object in a failure context a failure. */
const FAILURE_FIELDS = ['error', 'errors', 'failures', 'warnings', 'message', 'detail', 'description'];
/** Failure lists: every element in one is a failure, whatever its fields. */
const FAILURE_LISTS = new Set(['failures', 'failure', 'errors', 'error', 'warnings']);

/** One element of a failure list, reduced to a numeric status (when it has one) and our own text. */
function failureEntry(value: unknown): { status?: number; message: string } {
  const status =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { status, message: `Pleo reported a failure with HTTP ${status}.` }
    : { message: 'Pleo reported a failure.' };
}

/** A failure list: every element (an object with any fields, a text, a list) becomes a failureEntry. */
function failureList(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return Array.isArray(value) ? value.map(failureEntry) : failureEntry(value);
}

/**
 * Copy of a successful body with every failure reported inside it reduced to
 * its HTTP status and our own text.
 *
 * - Every element of a failure list (`failures`, `failure`, `errors`,
 *   `error`, `warnings`), at any depth, becomes `{ status?, message }`: a
 *   numeric status is kept, and every other field, whatever its name, is
 *   dropped. Nothing below a failure list is kept.
 * - Elsewhere a failure is an object with a numeric `status` of 400 or
 *   more, an object with an `error` field, or an object in a failure
 *   context (`metadata`, `amount` and the like, also through wrappers such
 *   as `data` below them) with any of `error`, `errors`, `failures`,
 *   `warnings`, `message`, `detail` or `description`. It becomes
 *   `{ status?, error }` with our own text.
 *
 * A text outside a failure list, an amount among them, is kept.
 * Depth-limited.
 */
export function nestedFailuresAsStatus(value: unknown, depth = 0, context = false): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => nestedFailuresAsStatus(entry, depth + 1, context));
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const failedStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
  const present = (field: string) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined;
  if (failedStatus || present('error') || (context && FAILURE_FIELDS.some(present))) {
    return failedStatus
      ? { status, error: `Pleo reported a failure with HTTP ${status}.` }
      : { error: 'Pleo reported a failure.' };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      FAILURE_LISTS.has(key)
        ? failureList(entry)
        : // A failure context holds through wrappers such as `data` below it.
          nestedFailuresAsStatus(entry, depth + 1, context || FAILURE_CONTEXTS.has(key)),
    ]),
  );
}

/** A header value that is a whole number of at most 9 digits, as text; anything else is dropped. */
function wholeNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{1,9}$/.test(trimmed) ? String(Number(trimmed)) : undefined;
}
