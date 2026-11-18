import { current } from '../i18n/index.ts';
import type { Messages } from '../i18n/index.ts';
import { apiBaseUrl } from './config.ts';

export type ApiErrorKind = 'configuration' | 'network' | 'timeout' | 'http' | 'validation' | 'response';

/** A text picked from the messages of whichever language is current when it is shown. */
export type Localized = (text: Messages) => string;

export interface ValidationIssue {
  field: string;
  /** The text when the issue was found. Kept for logs and tests; the UI shows issueMessage(). */
  message: string;
  /** Present for checks made in the browser. Server issues have none: their text is not translated. */
  text?: Localized;
}

/** A problem found in the browser, rendered in the current language each time it is shown. */
export function localIssue(field: string, text: Localized): ValidationIssue {
  return { field, message: text(current()), text };
}

/** The issue in the current language; a server issue gets a translated general text. */
export function issueMessage(issue: ValidationIssue): string {
  return issue.text ? issue.text(current()) : current().api.invalid;
}

interface ApiErrorOptions {
  kind: ApiErrorKind;
  status?: number;
  code?: string;
  issues?: ValidationIssue[];
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly issues: ValidationIssue[];
  /** The UI text in any language. Absent when the message came from the server. */
  readonly text: Localized | undefined;

  /**
   * A Localized message is translated each time the error is shown, so an error already on screen follows
   * a language switch. `message` keeps the text of the moment for logs and tests.
   */
  constructor(message: string | Localized, options: ApiErrorOptions) {
    super(typeof message === 'string' ? message : message(current()), { cause: options.cause });
    this.text = typeof message === 'string' ? undefined : message;
    this.name = 'ApiError';
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.issues = options.issues ?? [];
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON request body. Omit it for GET and requests without a body. */
  body?: unknown;
  /** Explicit access token; the client does not store or refresh tokens. */
  token?: string;
  /** Return a successful response as a Blob (a file download) instead of parsed JSON. Errors stay JSON. */
  blob?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validationIssues(payload: unknown): ValidationIssue[] {
  if (!isRecord(payload) || !Array.isArray(payload.detail)) return [];

  return payload.detail.flatMap((item: unknown): ValidationIssue[] => {
    if (!isRecord(item)) return [];
    const message = nonemptyString(item.msg);
    if (!message) return [];

    const location = Array.isArray(item.loc)
      ? item.loc.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      : [];
    if (['body', 'query', 'path', 'header', 'cookie'].includes(String(location[0]))) {
      location.shift();
    }
    return [{ field: location.join('.'), message }];
  });
}

function fallbackHttpMessage(status: number): Localized {
  if (status >= 500) return (text) => text.api.server;
  switch (status) {
    case 401: return (text) => text.api.unauthorized;
    case 403: return (text) => text.api.forbidden;
    case 404: return (text) => text.api.notFound;
    case 409: return (text) => text.api.conflict;
    case 422: return (text) => text.api.invalid;
    case 429: return (text) => text.api.tooMany;
    default: return (text) => text.api.http(status);
  }
}

function httpError(status: number, payload: unknown): ApiError {
  const issues = status === 422 ? validationIssues(payload) : [];
  let message = issues.map(({ field, message: issue }) => field ? `${field}: ${issue}` : issue).join('; ');

  if (!message && status < 500) {
    const detail = isRecord(payload) ? payload.detail : undefined;
    message = nonemptyString(detail)
      ?? (isRecord(detail) ? nonemptyString(detail.message) ?? nonemptyString(detail.msg) : undefined)
      ?? (isRecord(payload) ? nonemptyString(payload.message) : nonemptyString(payload))
      ?? '';
  }

  return new ApiError(message || fallbackHttpMessage(status), {
    kind: status === 422 ? 'validation' : 'http',
    status,
    code: status < 500 && isRecord(payload) && isRecord(payload.detail) ? nonemptyString(payload.detail.code) : undefined,
    issues,
  });
}

function requestUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl?.trim()) {
    throw new ApiError((text) => text.api.noUrl, {
      kind: 'configuration',
    });
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ApiError((text) => text.api.badPath, { kind: 'configuration' });
  }
  try {
    return apiBaseUrl(baseUrl) + path;
  } catch (cause) {
    throw new ApiError((text) => text.api.badUrl, {
      kind: 'configuration',
      cause,
    });
  }
}

/** A JSON HTTP client that can also fetch a file as a Blob. fetchImpl can be replaced in isolated tests. */
export function createApiClient(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = 15000) {
  return {
    async request<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
      const url = requestUrl(baseUrl, path);
      const { body, token, blob, headers: suppliedHeaders, ...init } = options;
      const headers = new Headers(suppliedHeaders);
      if (!headers.has('Accept')) headers.set('Accept', blob ? 'application/pdf, application/json' : 'application/json');
      if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (token) headers.set('Authorization', `Bearer ${token}`);

      let serializedBody: string | undefined;
      try {
        serializedBody = body === undefined ? undefined : JSON.stringify(body);
      } catch (cause) {
        throw new ApiError((text) => text.api.prepare, { kind: 'configuration', cause });
      }

      let response: Response;
      let text: string;
      const deadline = new AbortController();
      const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      try {
        response = await fetchImpl(url, { ...init, signal, headers, body: serializedBody });
        // Read the file inside the same deadline, so a stalled download is reported as a timeout.
        if (blob && response.ok) return await response.blob() as T;
        text = await response.text();
      } catch (cause) {
        // Cancellation belongs to the caller and must not look like a network failure.
        if (init.signal?.aborted) throw cause;
        if (deadline.signal.aborted) {
          throw new ApiError((text) => text.api.timeout + (path === '/auth/register' ? text.api.timeoutRegister : ''), {
            kind: 'timeout', cause,
          });
        }
        if (cause instanceof Error && cause.name === 'AbortError') throw cause;
        throw new ApiError((text) => text.api.network, {
          kind: 'network',
          cause,
        });
      } finally {
        clearTimeout(timer);
      }

      let payload: unknown;
      try {
        payload = text.trim() ? JSON.parse(text) : undefined;
      } catch (cause) {
        if (response.ok) {
          throw new ApiError((text) => text.api.badResponse, {
            kind: 'response',
            status: response.status,
            cause,
          });
        }
        // HTML/text proxy errors must not be rendered as page content.
      }

      if (!response.ok) throw httpError(response.status, payload);
      // Use request<void> for endpoints with an empty response (e.g. HTTP 204).
      return payload as T;
    },
  };
}

/**
 * UI-safe message in the current language, without stringifying arbitrary objects or response bodies.
 * Call it while rendering, never store its result: the text then follows a language switch.
 * Server wording (FastAPI `detail`) is English and is not shown; callers map known codes first.
 */
export function getErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return current().api.unknown;
  if (error.text) return error.text(current());
  if (error.status !== undefined) return fallbackHttpMessage(error.status)(current());
  return error.message;
}
