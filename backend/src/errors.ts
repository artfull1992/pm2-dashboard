import { STATUS_CODES } from 'node:http';
import { constants } from 'node:os';
import { errorCodes } from 'fastify';
import pg from 'pg';

// Error policy (see docs/DECISIONS.md, ADR-007):
// - Logs and stderr get ONLY ErrorMeta: a fixed category plus a code from an allowlist.
//   message, name, stack and cause are never emitted — they can carry arbitrary text (SQL, tokens, values).
// - Clients get a fixed contract built from the HTTP status (and, for schema validation, schema-derived paths).

export type ErrorCategory = 'validation' | 'client' | 'timeout' | 'database' | 'system' | 'internal' | 'non-error';

export interface ErrorMeta {
  readonly category: ErrorCategory;
  /** Present only when the code is in an allowlist: Node errno, Fastify error codes, PostgreSQL SQLSTATE. */
  readonly code?: string;
  readonly statusCode?: number;
}

const ERRNO_CODES = new Set([...Object.keys(constants.errno), 'ETIMEDOUT']);
const FASTIFY_CODES = new Set(Object.keys(errorCodes));
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function httpStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const status = (value as Record<string, unknown>).statusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

/** Thrown by our own timeout helper; carries no caller-provided text. */
export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(ms: number) {
    super(`Operation timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * An error whose public message is chosen by server code (never derived from input or other errors).
 * Used for the fixed 401/403/429/503 contracts; `headers` (e.g. Retry-After) are applied to the response.
 */
export class PublicHttpError extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(statusCode: 401 | 403 | 429 | 503, publicMessage: string, headers: Record<string, string> = {}) {
    super(publicMessage);
    this.name = 'PublicHttpError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.headers = headers;
  }
}

export function describeError(error: unknown): ErrorMeta {
  if (!(error instanceof Error)) return { category: 'non-error' };
  if (error instanceof PublicHttpError) {
    return { category: error.statusCode >= 500 ? 'internal' : 'client', statusCode: error.statusCode };
  }

  const code = ownString(error, 'code');
  const statusCode = httpStatus(error);
  const withStatus = statusCode === undefined ? {} : { statusCode };

  if (error instanceof TimeoutError) return { category: 'timeout', code: 'ETIMEDOUT' };
  if (error instanceof pg.DatabaseError) {
    return { category: 'database', ...(code !== undefined && SQLSTATE_RE.test(code) ? { code } : {}) };
  }
  if ('validation' in error && Array.isArray(error.validation)) {
    return { category: 'validation', code: 'FST_ERR_VALIDATION', ...withStatus };
  }
  if (code !== undefined && FASTIFY_CODES.has(code)) {
    return { category: statusCode !== undefined && statusCode < 500 ? 'client' : 'internal', code, ...withStatus };
  }
  if (code !== undefined && ERRNO_CODES.has(code)) return { category: 'system', code, ...withStatus };
  if (statusCode !== undefined && statusCode < 500) return { category: 'client', statusCode };
  return { category: 'internal', ...withStatus };
}

/** One-line form for stderr: `category=system code=EADDRINUSE`. */
export function formatErrorMeta(meta: ErrorMeta): string {
  return [`category=${meta.category}`, meta.code && `code=${meta.code}`, meta.statusCode && `status=${meta.statusCode}`]
    .filter(Boolean)
    .join(' ');
}

export interface ValidationIssue {
  location: string;
  path: string;
  rule: string;
}

export interface ErrorResponse {
  statusCode: number;
  body: { statusCode: number; error: string; message: string; validation?: ValidationIssue[] };
  headers?: Readonly<Record<string, string>>;
}

const VALIDATION_LOCATIONS = new Set(['body', 'querystring', 'params', 'headers']);
const MAX_VALIDATION_ISSUES = 10;

// Paths come from Ajv's instancePath/missingProperty, i.e. from schema structure — never received values.
// Ajv's `message` and `params` (which may include client-supplied keys) are not forwarded.
function validationIssues(error: Error): ValidationIssue[] {
  const raw = (error as { validation?: unknown }).validation;
  const contextRaw = ownString(error, 'validationContext');
  const location = contextRaw !== undefined && VALIDATION_LOCATIONS.has(contextRaw) ? contextRaw : 'request';
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_VALIDATION_ISSUES).map((item: unknown) => {
    const keyword = ownString(item, 'keyword') ?? 'invalid';
    const instancePath = ownString(item, 'instancePath') ?? '';
    const params = typeof item === 'object' && item !== null ? (item as { params?: unknown }).params : undefined;
    const missing = keyword === 'required' ? ownString(params, 'missingProperty') : undefined;
    const path = missing === undefined ? instancePath || '/' : `${instancePath}/${missing}`;
    return { location, path: path.slice(0, 200), rule: keyword.slice(0, 50) };
  });
}

/** Maps any thrown value to a fixed public contract. Never reflects message/name/cause/stack. */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof PublicHttpError) {
    const text = STATUS_CODES[error.statusCode] ?? 'Error';
    return {
      statusCode: error.statusCode,
      body: { statusCode: error.statusCode, error: text, message: error.publicMessage },
      headers: error.headers,
    };
  }
  const meta = describeError(error);
  if (meta.category === 'validation' && error instanceof Error) {
    return {
      statusCode: 400,
      body: { statusCode: 400, error: 'Bad Request', message: 'Request validation failed', validation: validationIssues(error) },
    };
  }
  const status = meta.statusCode !== undefined && meta.statusCode < 500 ? meta.statusCode : 500;
  const text = STATUS_CODES[status] ?? (status < 500 ? 'Client Error' : 'Internal Server Error');
  return { statusCode: status, body: { statusCode: status, error: text, message: text } };
}
