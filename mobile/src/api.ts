export type StaffEvent = {
  id: number;
  title: string;
  date: string;
  location: string;
};

export type StaffSession = { token: string; userId: number };

export type Attendance = {
  event_id: number;
  capacity: number;
  tickets_issued: number;
  checked_in: number;
};

export type Attendee = {
  ticket_id: number;
  full_name: string;
  masked_email: string;
  checked_in_at: string | null;
  qr_payload: string;
};

export type ScanRequest = { qr_payload: string; request_id: string };
export type Receipt = {
  status: 'CHECKED_IN';
  event_id: number;
  ticket_id: number;
  request_id: string;
  checked_in_at: string;
};

export class ApiError extends Error {
  code: string;
  status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function apiAddress(value: string) {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.href.includes('?') || url.href.includes('#')) {
      throw new Error();
    }
    if (['localhost', '0.0.0.0', '[::1]'].includes(url.hostname) || url.hostname.startsWith('127.')) {
      throw new Error();
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new ApiError('CONFIG_ERROR', 'Set EXPO_PUBLIC_API_URL to the shared backend URL or your computer’s LAN address, not localhost.');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function canSearchAttendees(query: string): boolean {
  return Array.from(query.trim()).length >= 3;
}

function isAttendee(value: unknown): value is Attendee {
  return object(value) && count(value.ticket_id) && value.ticket_id > 0
    && typeof value.full_name === 'string' && typeof value.masked_email === 'string'
    && (value.checked_in_at === null || (typeof value.checked_in_at === 'string'
      && Number.isFinite(Date.parse(value.checked_in_at))))
    && typeof value.qr_payload === 'string' && value.qr_payload.length > 0 && value.qr_payload.length <= 512;
}

function httpError(status: number, body: unknown) {
  const detail = object(body) ? body.detail : undefined;
  const code = object(detail) && typeof detail.code === 'string' ? detail.code : '';
  if (status === 401) {
    return new ApiError('UNAUTHORIZED', 'Sign in again to continue.', status);
  }
  if (status === 403) {
    return new ApiError('FORBIDDEN', 'You do not have access to this event. Ask the organizer to check your assignment.', status);
  }
  if (status === 409 && code === 'ALREADY_CHECKED_IN') {
    return new ApiError(code, 'This ticket has already been used.', status);
  }
  if (status === 404 && code === 'INVALID_TICKET') {
    return new ApiError(code, 'This QR is not a valid ticket for this event.', status);
  }
  if (status === 404 && code === 'EVENT_NOT_FOUND') {
    return new ApiError(code, 'This event could not be found. Return to the event list to refresh it.', status);
  }
  if (status === 409 && code === 'EVENT_CANCELLED') {
    return new ApiError(code, 'This event has been cancelled. Return to the event list to refresh it.', status);
  }
  if (status === 409 && code === 'EVENT_NOT_PUBLISHED') {
    return new ApiError(code, 'This event is not published. Return to the event list to refresh it.', status);
  }
  if (status === 409 && code === 'REQUEST_ID_CONFLICT') {
    return new ApiError(code, 'This scan conflicts with an earlier request. Ask the organizer to verify the ticket.', status);
  }
  if (status === 404 || status === 405) {
    return new ApiError('NOT_AVAILABLE', 'This API route is unavailable on the configured server.', status);
  }
  if (status === 422) {
    if (code === 'QUERY_TOO_SHORT') {
      return new ApiError(code, 'Enter at least three characters to search for an attendee.', status);
    }
    return new ApiError('INVALID_INPUT', 'The server rejected the request format. Check the entered details or the ticket QR.', status);
  }
  if (status >= 500) {
    return new ApiError('SERVER_ERROR', 'The server could not complete the request. Please retry.', status);
  }
  return new ApiError(code || 'REQUEST_ERROR', object(detail) && typeof detail.message === 'string'
    ? detail.message : typeof detail === 'string' ? detail : 'The request was rejected. Please check with the organizer.', status);
}

// All API paths live here so we can adjust the contract with the backend team.
export function createApi(baseUrl: string, fetcher: typeof fetch = fetch, timeoutMs = 12000) {
  async function request(path: string, token?: string, body?: unknown): Promise<unknown> {
    const url = apiAddress(baseUrl) + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) throw httpError(response.status, data);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('NETWORK_ERROR', 'Connection lost or timed out. Check your network and retry.');
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async health(): Promise<void> {
      const data = await request('/health');
      if (!object(data) || data.status !== 'ok' || data.database !== 'up') {
        throw new ApiError('SERVER_ERROR', 'The API or database is not ready.');
      }
    },
    async login(email: string, password: string, expectedUserId?: number): Promise<StaffSession> {
      const data = await request('/auth/login', undefined, { email: email.trim(), password });
      if (!object(data) || typeof data.access_token !== 'string' || !data.access_token) {
        throw new ApiError('SERVER_ERROR', 'The server returned an invalid login response.');
      }
      const token = data.access_token;
      const user = await request('/auth/me', token);
      if (!object(user) || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id < 1) {
        throw new ApiError('SERVER_ERROR', 'The server did not identify the signed-in account.');
      }
      if (expectedUserId !== undefined && user.id !== expectedUserId) {
        throw new ApiError('ACCOUNT_MISMATCH', 'Use the same staff account to retry this check-in.');
      }
      return { token, userId: user.id };
    },
    async events(token: string): Promise<StaffEvent[]> {
      const data = await request('/staff/events', token);
      if (!Array.isArray(data) || !data.every(item => object(item) && Number.isInteger(item.id)
        && Number(item.id) > 0 && typeof item.title === 'string' && typeof item.date === 'string'
        && Number.isFinite(Date.parse(item.date)) && typeof item.location === 'string')) {
        throw new ApiError('SERVER_ERROR', 'The server returned an invalid event list.');
      }
      return data as StaffEvent[];
    },
    async attendance(token: string, eventId: number): Promise<Attendance> {
      const data = await request(`/events/${eventId}/attendance`, token);
      if (!object(data) || data.event_id !== eventId || !count(data.capacity) || data.capacity === 0
        || !count(data.tickets_issued) || !count(data.checked_in)
        || data.checked_in > data.tickets_issued || data.tickets_issued > data.capacity) {
        throw new ApiError('SERVER_ERROR', 'The server returned invalid attendance counts.');
      }
      return data as Attendance;
    },
    async attendees(token: string, eventId: number, query: string): Promise<Attendee[]> {
      const term = query.trim();
      if (!canSearchAttendees(term)) {
        throw new ApiError('QUERY_TOO_SHORT', 'Enter at least three characters to search for an attendee.');
      }
      const data = await request(`/events/${eventId}/attendees?q=${encodeURIComponent(term)}`, token);
      if (!Array.isArray(data) || data.length > 20 || !data.every(isAttendee)) {
        throw new ApiError('SERVER_ERROR', 'The server returned an invalid attendee list.');
      }
      return data;
    },
    async checkIn(token: string, eventId: number, body: ScanRequest): Promise<Receipt> {
      const data = await request(`/events/${eventId}/check-in`, token, body);
      // A 2xx status alone is not proof of admission.
      if (!object(data) || data.status !== 'CHECKED_IN' || data.event_id !== eventId
        || data.request_id !== body.request_id || !Number.isInteger(data.ticket_id) || Number(data.ticket_id) < 1
        || typeof data.checked_in_at !== 'string' || !Number.isFinite(Date.parse(data.checked_in_at))) {
        throw new ApiError('SERVER_ERROR', 'The server did not confirm this check-in. Do not admit the attendee yet.');
      }
      return data as Receipt;
    },
  };
}

export const api = createApi(process.env.EXPO_PUBLIC_API_URL || '');
