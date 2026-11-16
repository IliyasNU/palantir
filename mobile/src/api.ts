export type StaffEvent = {
  id: number;
  title: string;
  date: string;
  location: string;
  // True only when the server says this account manages the event (organizer or admin).
  can_manage?: boolean;
};

// `refreshToken` renews the access token without the password. It is absent when the server issues none.
export type StaffSession = { token: string; userId: number; refreshToken?: string };

export type Attendance = {
  event_id: number;
  capacity: number;
  tickets_issued: number;
  checked_in: number;
};

export type TicketStatus = 'active' | 'cancelled' | 'refunded';

export type Attendee = {
  ticket_id: number;
  full_name: string;
  masked_email: string;
  status: TicketStatus;
  checked_in_at: string | null;
  // The current admission, needed to undo it. Null when the ticket is not admitted right now.
  check_in_id: number | null;
  qr_payload: string;
};

// What the door shows next to a ticket number: the holder, the ticket type and the seat (if the ticket has one).
export type DoorDetails = { ticket_id: number; full_name: string; ticket_type: string | null; seat_label: string | null };

export type ScanRequest = { qr_payload: string; request_id: string };
export type OfflineScanRequest = { client_scan_id: string; qr_payload: string; scanned_at: string };
export type OfflineScanResult = {
  client_scan_id: string;
  result: 'accepted' | 'conflict' | 'rejected';
  code?: string;
  ticket_id?: number;
  checked_in_at?: string;
  conflict?: { checked_in_at: string; staff_name: string };
};
export type Receipt = {
  status: 'CHECKED_IN';
  event_id: number;
  ticket_id: number;
  check_in_id?: number;
  request_id: string;
  checked_in_at: string;
};
export type UndoReceipt = {
  status: 'UNDONE';
  event_id: number;
  ticket_id: number;
  check_in_id: number;
  request_id: string;
  undone_at: string;
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

function id(value: unknown): value is number {
  return count(value) && value > 0;
}

function time(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// A server without ticket states omits `status` and `check_in_id`: such a ticket is active and cannot be undone.
function attendee(value: unknown): Attendee | null {
  if (!object(value) || !id(value.ticket_id) || typeof value.full_name !== 'string'
    || typeof value.masked_email !== 'string' || !(value.checked_in_at === null || time(value.checked_in_at))
    || typeof value.qr_payload !== 'string' || !value.qr_payload.length || value.qr_payload.length > 512) return null;
  const status = value.status === undefined ? 'active' : value.status;
  const checkInId = value.check_in_id === undefined ? null : value.check_in_id;
  if (status !== 'active' && status !== 'cancelled' && status !== 'refunded') return null;
  if (!(checkInId === null || id(checkInId))) return null;
  // A closed ticket is never admitted, and an admission id without an admission time is contradictory.
  if (value.checked_in_at === null ? checkInId !== null : status !== 'active') return null;
  return {
    ticket_id: value.ticket_id, full_name: value.full_name, masked_email: value.masked_email, status,
    checked_in_at: value.checked_in_at, check_in_id: checkInId, qr_payload: value.qr_payload,
  };
}

function httpError(status: number, body: unknown) {
  const detail = object(body) ? body.detail : undefined;
  const code = object(detail) && typeof detail.code === 'string' ? detail.code : '';
  if (status === 401) {
    return new ApiError('UNAUTHORIZED', 'Sign in again to continue.', status);
  }
  if (status === 403 && code === 'UNDO_NOT_ALLOWED') {
    return new ApiError(code, 'Only the event organizer or an admin can undo a check-in.', status);
  }
  if (status === 403) {
    return new ApiError('FORBIDDEN', 'You do not have access to this event. Ask the organizer to check your assignment.', status);
  }
  if (status === 409 && code === 'ALREADY_CHECKED_IN') {
    return new ApiError(code, 'This ticket has already been used.', status);
  }
  if (status === 409 && code === 'TICKET_CANCELLED') {
    return new ApiError(code, 'This ticket was cancelled and cannot be admitted.', status);
  }
  if (status === 409 && code === 'TICKET_REFUNDED') {
    return new ApiError(code, 'This ticket was refunded and cannot be admitted.', status);
  }
  if (status === 409 && code === 'CHECK_IN_UNDONE') {
    return new ApiError(code, 'This check-in was undone. Scan the ticket again to admit the attendee.', status);
  }
  if (status === 409 && code === 'CHECK_IN_ALREADY_UNDONE') {
    return new ApiError(code, 'This check-in was already undone.', status);
  }
  if (status === 404 && code === 'CHECK_IN_NOT_FOUND') {
    return new ApiError(code, 'This check-in could not be found. Refresh the search.', status);
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
    if (code === 'CAMPAIGN_QR_NOT_A_TICKET') {
      return new ApiError(code, 'This QR is a promo campaign link, not a ticket. Ask for the ticket QR.', status);
    }
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

  // A token pair is trusted only after GET /auth/me names its account with the new access token.
  async function identified(data: unknown, expectedUserId?: number, previousRefresh?: string): Promise<StaffSession> {
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
    const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previousRefresh;
    return { token, userId: user.id, ...(refreshToken ? { refreshToken } : {}) };
  }

  return {
    async health(): Promise<void> {
      const data = await request('/health');
      if (!object(data) || data.status !== 'ok' || data.database !== 'up') {
        throw new ApiError('SERVER_ERROR', 'The API or database is not ready.');
      }
    },
    async login(email: string, password: string, expectedUserId?: number): Promise<StaffSession> {
      return identified(await request('/auth/login', undefined, { email: email.trim(), password }), expectedUserId);
    },
    // Exchanges the refresh token for a new pair. The new access token must belong to the same account,
    // so a renewed session can repeat that account's unconfirmed requests.
    async refresh(refreshToken: string, userId: number): Promise<StaffSession> {
      return identified(await request('/auth/refresh', undefined, { refresh_token: refreshToken }), userId, refreshToken);
    },
    async events(token: string): Promise<StaffEvent[]> {
      const data = await request('/staff/events', token);
      if (!Array.isArray(data) || !data.every(item => object(item) && Number.isInteger(item.id)
        && Number(item.id) > 0 && typeof item.title === 'string' && typeof item.date === 'string'
        && Number.isFinite(Date.parse(item.date)) && typeof item.location === 'string'
        && (item.can_manage === undefined || typeof item.can_manage === 'boolean'))) {
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
      const rows = Array.isArray(data) && data.length <= 20 ? data.map(attendee) : [null];
      if (!rows.every(row => row !== null)) {
        throw new ApiError('SERVER_ERROR', 'The server returned an invalid attendee list.');
      }
      return rows;
    },
    // Name, ticket type and seat for up to 20 tickets of the event. Extra information only: admission is decided
    // by the check-in receipt, never by this answer.
    async doorDetails(token: string, eventId: number, ticketIds: readonly number[]): Promise<DoorDetails[]> {
      const ids = [...new Set(ticketIds)].filter(value => id(value)).slice(0, 20);
      if (!ids.length) return [];
      const data = await request(`/events/${eventId}/door-details?${ids.map(value => `ticket_id=${value}`).join('&')}`, token);
      const text = (value: unknown): value is string | null => value === null || typeof value === 'string';
      if (!Array.isArray(data) || !data.every(item => object(item) && id(item.ticket_id) && ids.includes(item.ticket_id)
        && typeof item.full_name === 'string' && text(item.ticket_type) && text(item.seat_label))) {
        throw new ApiError('SERVER_ERROR', 'The server returned invalid door details.');
      }
      return (data as Record<string, unknown>[]).map(item => ({ ticket_id: item.ticket_id as number, full_name: item.full_name as string,
        ticket_type: item.ticket_type as string | null, seat_label: item.seat_label as string | null }));
    },
    async checkIn(token: string, eventId: number, body: ScanRequest): Promise<Receipt> {
      const data = await request(`/events/${eventId}/check-in`, token, body);
      // A 2xx status alone is not proof of admission.
      if (!object(data) || data.status !== 'CHECKED_IN' || data.event_id !== eventId
        || data.request_id !== body.request_id || !Number.isInteger(data.ticket_id) || Number(data.ticket_id) < 1
        || typeof data.checked_in_at !== 'string' || !Number.isFinite(Date.parse(data.checked_in_at))
        || !(data.check_in_id === undefined || id(data.check_in_id))) {
        throw new ApiError('SERVER_ERROR', 'The server did not confirm this check-in. Do not admit the attendee yet.');
      }
      return data as Receipt;
    },
    // Bonus 15: scans queued offline. Every scan must be answered, in order, with its own id; anything else is
    // treated as no answer, so the queue is kept and the same batch can be sent again.
    async syncScans(token: string, eventId: number, scans: readonly OfflineScanRequest[]): Promise<OfflineScanResult[]> {
      const data = await request(`/events/${eventId}/check-in/sync`, token, { scans });
      const results = object(data) && data.event_id === eventId && Array.isArray(data.results) ? data.results : null;
      const valid = results !== null && results.length === scans.length && results.every((item, index) => object(item)
        && item.client_scan_id === scans[index].client_scan_id
        && (item.result === 'accepted' ? id(item.ticket_id) && time(item.checked_in_at)
          : (item.result === 'conflict' || item.result === 'rejected') && typeof item.code === 'string')
        && (item.conflict === undefined || item.conflict === null
          || (object(item.conflict) && time(item.conflict.checked_in_at) && typeof item.conflict.staff_name === 'string')));
      if (!valid) throw new ApiError('SERVER_ERROR', 'The server did not confirm the offline scans. Keep the queue and retry.');
      return (results as Record<string, unknown>[]).map(item => ({
        client_scan_id: item.client_scan_id as string, result: item.result as OfflineScanResult['result'],
        ...(typeof item.code === 'string' ? { code: item.code } : {}),
        ...(id(item.ticket_id) ? { ticket_id: item.ticket_id } : {}),
        ...(time(item.checked_in_at) ? { checked_in_at: item.checked_in_at } : {}),
        ...(object(item.conflict) ? { conflict: { checked_in_at: item.conflict.checked_in_at as string, staff_name: item.conflict.staff_name as string } } : {}),
      }));
    },
    async undoCheckIn(token: string, eventId: number, checkInId: number, requestId: string): Promise<UndoReceipt> {
      const data = await request(`/events/${eventId}/check-ins/${checkInId}/undo`, token, { request_id: requestId });
      // As with check-in, a 2xx status alone does not prove the admission was reversed.
      if (!object(data) || data.status !== 'UNDONE' || data.event_id !== eventId || data.check_in_id !== checkInId
        || data.request_id !== requestId || !id(data.ticket_id) || !time(data.undone_at)) {
        throw new ApiError('SERVER_ERROR', 'The server did not confirm the undo. The attendee may still be checked in.');
      }
      return data as UndoReceipt;
    },
  };
}

export const api = createApi(process.env.EXPO_PUBLIC_API_URL || '');
