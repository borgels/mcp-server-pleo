import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  failureMetadata,
  formatUnknownError,
  MAX_REDACT_DEPTH,
  redactCredentialPatterns,
  vendorRequestId,
  type FailureMetadata,
} from './errors.js';
import { writeAuditEvent } from './pleo/audit.js';
import { DEFAULT_BASE_URL, PleoClient, type PleoClientOptions } from './pleo/client.js';
import {
  canonicalToolName,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './pleo/scope.js';
import { registerPleoTools } from './tools/pleo.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import { basicCredential, REDACTION_MARKER, SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Handlers, input schemas, policy checks and
 * audit are shared with the MCP server in src/tools/pleo.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API key passed to createPleoGateway
 * (never PLEO_API_KEY, PLEO_ACCESS_TOKEN or PLEO_BASE_URL from the
 * environment) and redacts results, errors and audit records with its own
 * key only.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`: that instance then reads none of PLEO_ENABLE_WRITES,
 * PLEO_POLICY_PATH or PLEO_AUDIT_LOG, so two tenants in one process can have
 * different settings. Without `policy` the instance uses the environment, as
 * the MCP server does. Limits (PLEO_TIMEOUT_MS) are still read from the
 * environment when `timeoutMs` is not given.
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), with or
 * without a policy, so a call made from inside another instance's call (from
 * its audit sink or its fetch) never inherits that instance's policy, sink,
 * redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './pleo/scope.js';
export { GatewayConfigError } from './pleo/scope.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Pleo answered with,
 * and its own request id when a response header gives one as a UUID or hex id. For a host that counts failures
 * without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Pleo only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Pleo API request a tool may make: the method and the path template on the configured base URL. */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Pleo request the tool may make. Empty for a tool that does not call Pleo. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. No gateway tool is
   * broad: the free REST read (`rest_read`) is not in the gateway.
   */
  readonly broad: boolean;
}

export interface PleoGatewayOptions
  extends Omit<PleoClientOptions, 'apiKey' | 'accessToken' | 'baseUrl' | 'credentialEnv' | 'redactor'> {
  /** The customer's standalone Pleo API key (sent as Basic auth). Required; never read from the environment. */
  apiKey: string;
  /** Pleo API base URL. Default https://external.pleo.io; never read from the environment. */
  baseUrl?: string;
  /**
   * Instance policy from the host. When given, the instance reads no policy
   * or audit variables from the environment (see InstancePolicy). A host
   * serving several tenants should always pass it.
   */
  policy?: InstancePolicy;
}

const get = (path: string): GatewayUpstreamOperation => ({ method: 'GET', path });
const post = (path: string): GatewayUpstreamOperation => ({ method: 'POST', path });

/** The gateway's tools: a curated read-only subset of the MCP server's tools, with their own titles. */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstreamOperation[];
  broad?: boolean;
}> = [
  {
    name: 'search_capabilities',
    title: 'Search Pleo capabilities',
    description: 'Find the Pleo tools this connection offers for companies, employees, vendors and exports.',
    riskLevel: 'read',
    summary: 'Pleo capabilities.',
    upstream: [],
  },
  {
    name: 'check_connection',
    title: 'Check Pleo connection',
    description: 'Verify that Pleo accepts the configured API key.',
    riskLevel: 'read',
    summary: 'Pleo connection checked.',
    upstream: [get('/v1/introspect')],
  },
  {
    name: 'introspect_auth',
    title: 'Introspect Pleo auth',
    description: 'Return Pleo authentication metadata and granted scopes.',
    riskLevel: 'read',
    summary: 'Pleo authentication metadata.',
    upstream: [get('/v1/introspect')],
  },
  {
    name: 'search_companies',
    title: 'Search Pleo companies',
    description: 'Search the companies available to the configured Pleo API key.',
    riskLevel: 'read',
    summary: 'Pleo companies.',
    upstream: [get('/v1/companies')],
  },
  {
    name: 'search_employees',
    title: 'Search Pleo employees',
    description: 'Search employees by company, email, code, and pagination.',
    riskLevel: 'read',
    summary: 'Pleo employees.',
    upstream: [get('/v2/employees')],
  },
  {
    name: 'search_vendors',
    title: 'Search Pleo vendors',
    description: 'Search vendors for a company by name, code, country, state, or tax registration number.',
    riskLevel: 'read',
    summary: 'Pleo vendors.',
    upstream: [post('/v1/vendors:search')],
  },
  {
    name: 'list_export_jobs',
    title: 'List Pleo export jobs',
    description: 'List Pleo Export API jobs by company, status, and pagination.',
    riskLevel: 'read',
    summary: 'Pleo export jobs.',
    upstream: [get('/v3/export-jobs')],
  },
  {
    name: 'list_export_items',
    title: 'List Pleo export items',
    description: 'Read transformed accounting and bookkeeping export items.',
    riskLevel: 'read',
    summary: 'Pleo export items.',
    upstream: [get('/v3/export-items')],
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/**
 * The MCP server's tools as registered: the zod input schema (strict: an
 * unknown field is refused, not dropped) and the handler bound to `client`.
 */
function registeredTools(client: PleoClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: z.strictObject(config.inputSchema ?? {}), handler });
    },
  };
  registerPleoTools(server as never, client);
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new PleoClient({ apiKey: 'schema-only', credentialEnv: {}, redactor: new SecretRedactor(), timeoutMs: 1 }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(`${TOOL_PREFIX}${tool.name}`);
  if (!registered) {
    throw new Error(`Pleo gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const pleoGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `pleoGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const pleoToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => `${TOOL_PREFIX}${tool.name}`);
const SUMMARIES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool.summary]),
);

function requiredKey(options: PleoGatewayOptions | undefined): string {
  const value: unknown = options?.apiKey;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(
      'createPleoGateway requires options.apiKey. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new GatewayConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/** A caller or request id from the host: redacted before it is cut short, so no part of a key survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiKey` is required and is the only
 * credential the instance uses; a missing or refused key fails here, before
 * anything is built or sent.
 */
export function createPleoGateway(options: PleoGatewayOptions) {
  let apiKey: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const given: unknown = (options as Partial<PleoGatewayOptions> | undefined)?.apiKey;
  const secrets = typeof given === 'string' ? [given, given.trim()] : [];
  try {
    // Admission first, before a redactor is built from the key.
    apiKey = requiredKey(options);
    // The key and the Basic credential Pleo receives (base64 of `key:`).
    guard = new SecretRedactor().addSecret(apiKey).addSecret(basicCredential(apiKey));
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(keyRefusedText(apiKey));
    }
    const gateway = buildPleoGateway(options, apiKey, guard);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(keyRefusedText(apiKey));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && apiKey !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the key becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = keyRefusedText(apiKey);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the key. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && apiKey !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(keyRefusedText(apiKey)), ...secrets);
    }
    throw final;
  }
}

function buildPleoGateway(options: PleoGatewayOptions, apiKey: string, redactor: SecretRedactor) {
  const {
    policy: hostPolicy,
    apiKey: _key,
    baseUrl,
    // Not a gateway option: dropped even when a host passes it.
    accessToken: _accessToken,
    credentialEnv: _credentialEnv,
    redactor: _redactor,
    ...clientOptions
  } = options as PleoGatewayOptions & Pick<PleoClientOptions, 'accessToken' | 'credentialEnv' | 'redactor'>;
  const policy: ResolvedInstancePolicy | undefined =
    hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, GATEWAY_TOOL_NAMES);
  const client = new PleoClient({
    ...clientOptions,
    apiKey,
    baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    credentialEnv: {},
    redactor,
  });
  const handlers = registeredTools(client);
  const offeredTools: ReadonlySet<string> = new Set(
    GATEWAY_TOOL_NAMES.filter(name => !policy?.disabledTools.has(name)),
  );

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: pleoGatewayTools.filter(tool => !policy?.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // Every call in a scope of its own, with or without a host policy.
      return runInCallScope(
        {
          ...(policy ? { policy } : {}),
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data: it is not redacted again as text, which could break the JSON. An error result is our own text, and
        // is redacted as a whole.
        () =>
          runCall(toolName, input).then(result => {
            // The failure metadata is checked again after redaction: an id that redaction changed is dropped.
            const final = withFailureInForm(
              result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result,
            );
            // The sink check, as the very last step: a result that holds a piece of the key anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Pleo gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = name.slice(TOOL_PREFIX.length);
        return errorResult(formatUnknownError(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`));
      }

      const result = await tool.handler(parsed.data as Record<string, unknown>);
      return normalizeResult(result, redactor, SUMMARIES.get(name) ?? 'Pleo gateway result.');
    } catch (error) {
      return errorResult(formatUnknownError(error), failureMetadata(error));
    }
  }
}

/**
 * Field names whose value is a credential whatever it looks like: the value of
 * such a field is replaced whole, not only when it matches a pattern.
 */
const CREDENTIAL_NAME =
  /^x?(authorization|proxyauthorization|cookie|setcookie|(access|refresh|id|session|bearer|auth|api|private|secret|subscription)(token|key)|token|apisecret|clientsecret|secret|password|passwd|credentials?)$/;

/**
 * Whether a field name names a credential, however it is written: case, `-`,
 * `_`, spaces and a leading `x-` do not matter (`accessToken`, `access_token`,
 * `X-Api-Key`, `x-auth-token`, `api-key`).
 */
function isCredentialField(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase().replace(/[-_\s.]/g, ''));
}

/**
 * One text as a gateway may return it: credential-shaped text masked, then the instance's own secrets, then the
 * patterns again (they take the marker as part of a value), until nothing changes.
 */
function redactText(value: string, redactor: SecretRedactor): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactor.redact(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the credential patterns and the redactor, the value of every
 * credential-named field (isCredentialField) replaced whole, whatever its type, and every number
 * or boolean whose string form would be redacted replaced by the string
 * "‹redacted›". Anything nested deeper than MAX_REDACT_DEPTH is replaced,
 * never passed on.
 */
function redactDeep(value: unknown, redactor: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactText(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactText(text, redactor) !== text) return REDACTION_MARKER;
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactText(key, redactor),
      // The whole value of a credential-named field, whatever its type: a list or an object under it is a credential too.
      isCredentialField(key) && entry !== null && entry !== undefined ? REDACTION_MARKER : redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createPleoGateway. */
export type PleoGateway = ReturnType<typeof createPleoGateway>;

/**
 * The handler's result as the gateway returns it. The handler's text is
 * never kept: its data is parsed, redacted twice (values, keys and numbers by
 * their string form), and only then serialised again after the summary, so a
 * key cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor, summary: string): GatewayToolResult {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { content?: unknown }).content)) {
    // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
    return jsonResult(summary, redactDeep(redactDeep(result, redactor), redactor));
  }

  const content = (result as { content: Array<{ type?: unknown; text?: unknown }> }).content;
  const text = content[0]?.text;
  if (typeof text === 'string') {
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = undefined;
    }
    if (data !== undefined) {
      // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
      return jsonResult(summary, redactDeep(redactDeep(data, redactor), redactor));
    }
  }
  // Not JSON: each text redacted on its own.
  return {
    content: content
      .filter((entry): entry is { type: 'text'; text: string } => typeof entry.text === 'string')
      .map(entry => ({ type: 'text' as const, text: redactText(entry.text, redactor) })),
  };
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
