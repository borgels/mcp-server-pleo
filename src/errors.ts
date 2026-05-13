export interface PleoHttpErrorInput {
  status: number;
  method: string;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  requestId?: string;
  fallbackMessage?: string;
}

const SECRET_PATTERNS = [
  /Authorization:\s*(Bearer|Basic)\s+[^,\s}]+/gi,
  /(PLEO_API_KEY|PLEO_ACCESS_TOKEN|apiKey|accessToken|token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/g,
];

export class PleoHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly payload?: unknown;
  readonly retryAfter?: string;
  readonly requestId?: string;

  constructor(input: PleoHttpErrorInput) {
    super(formatPleoHttpError(input));
    this.name = 'PleoHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.requestId = input.requestId;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        if (/^(Bearer|Basic)\s/i.test(match)) {
          const scheme = match.split(/\s+/)[0] ?? 'Authorization';
          return `${scheme} [REDACTED]`;
        }

        if (/^Authorization:/i.test(match)) {
          return 'Authorization: [REDACTED]';
        }

        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatPleoHttpError(input: PleoHttpErrorInput): string {
  const parts = [
    `Pleo API request failed with HTTP ${input.status}`,
    `${input.method.toUpperCase()} ${redactSecrets(input.url)}`,
    input.requestId ? `request-id=${input.requestId}` : undefined,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    pleoErrorText(input.payload),
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function pleoErrorText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const value = payload as Record<string, unknown>;
  const message =
    value.message ??
    value.error ??
    value.errorMessage ??
    (Array.isArray(value.errors) ? value.errors.map(String).join(', ') : undefined);

  return typeof message === 'string' ? message : undefined;
}
