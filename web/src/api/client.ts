import { apiBaseUrl } from './config.ts';

export type ApiErrorKind = 'configuration' | 'network' | 'timeout' | 'http' | 'validation' | 'response';

export interface ValidationIssue {
  field: string;
  message: string;
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

  constructor(message: string, options: ApiErrorOptions) {
    super(message, { cause: options.cause });
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

function fallbackHttpMessage(status: number): string {
  if (status >= 500) return 'Сервер временно недоступен. Попробуйте позже.';
  switch (status) {
    case 401: return 'Для продолжения необходимо войти в аккаунт.';
    case 403: return 'У вас нет доступа к этому действию.';
    case 404: return 'Запрошенные данные не найдены.';
    case 409: return 'Данные конфликтуют с уже существующей записью.';
    case 422: return 'Проверьте введённые данные.';
    case 429: return 'Слишком много запросов. Попробуйте немного позже.';
    default: return `Не удалось выполнить запрос (HTTP ${status}).`;
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
    throw new ApiError('Не задан VITE_API_URL. Укажите адрес работающего API в web/.env.local и перезапустите Vite. Для опубликованного сайта задайте адрес перед сборкой и опубликуйте её заново.', {
      kind: 'configuration',
    });
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ApiError('Некорректный путь запроса API.', { kind: 'configuration' });
  }
  try {
    return apiBaseUrl(baseUrl) + path;
  } catch (cause) {
    throw new ApiError('Некорректный VITE_API_URL. Нужен полный адрес HTTP(S) без логина, пароля, query и hash. Исправьте настройку и перезапустите Vite или пересоберите опубликованный сайт.', {
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
        throw new ApiError('Не удалось подготовить данные запроса.', { kind: 'configuration', cause });
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
          throw new ApiError('Сервер не ответил вовремя. Попробуйте снова.'
            + (path === '/auth/register' ? ' Аккаунт мог быть создан: попробуйте войти.' : ''), {
            kind: 'timeout', cause,
          });
        }
        if (cause instanceof Error && cause.name === 'AbortError') throw cause;
        throw new ApiError('Не удалось связаться с сервером. Проверьте подключение и попробуйте снова.', {
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
          throw new ApiError('Сервер вернул некорректный ответ. Попробуйте позже.', {
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

/** UI-safe message, without stringifying arbitrary objects or response bodies. */
export function getErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Произошла ошибка. Попробуйте ещё раз.';
}
