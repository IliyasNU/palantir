import { ApiError, getErrorMessage } from '../api/client.ts';

export interface Ticket {
  id: number;
  event_id: number;
  attendee_id: number;
  qr_payload: string;
  created_at: string;
  checked_in_at: string | null;
  event: { id: number; title: string; date: string; location: string; status: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function invalidTicket(): ApiError {
  return new ApiError('Сервер вернул некорректный билет. Попробуйте позже.', { kind: 'response' });
}

/** Validate the server response; encode qr_payload unchanged, without a client prefix. */
export function readTicket(payload: unknown, expectedId?: number, expectedEventId?: number): Ticket {
  if (!record(payload) || !positiveId(payload.id) || !positiveId(payload.event_id) || !positiveId(payload.attendee_id)
    || (expectedId !== undefined && payload.id !== expectedId)
    || (expectedEventId !== undefined && payload.event_id !== expectedEventId)
    || typeof payload.qr_payload !== 'string' || !payload.qr_payload || payload.qr_payload.length > 512
    || !date(payload.created_at) || (payload.checked_in_at !== null && !date(payload.checked_in_at))
    || !record(payload.event) || payload.event.id !== payload.event_id
    || typeof payload.event.title !== 'string' || !payload.event.title.trim()
    || !date(payload.event.date) || typeof payload.event.location !== 'string' || typeof payload.event.status !== 'string') {
    throw invalidTicket();
  }
  return {
    id: payload.id, event_id: payload.event_id, attendee_id: payload.attendee_id,
    qr_payload: payload.qr_payload, created_at: payload.created_at, checked_in_at: payload.checked_in_at,
    event: { id: payload.event.id as number, title: payload.event.title, date: payload.event.date,
      location: payload.event.location, status: payload.event.status },
  };
}

export function readTickets(payload: unknown): Ticket[] {
  if (!Array.isArray(payload)) throw invalidTicket();
  return payload.map((ticket) => readTicket(ticket));
}

export function ticketErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Сессия завершена. Войдите снова, чтобы открыть билет или получить его.';
    if (error.status === 403) return 'У вас нет прав для этого действия с билетом.';
    switch (error.code) {
      case 'SOLD_OUT': return 'Свободных билетов больше нет. Уже полученные билеты доступны в разделе «Мои билеты».';
      case 'EVENT_CANCELLED': return 'Событие отменено. Уже полученный билет доступен в разделе «Мои билеты».';
      case 'EVENT_NOT_PUBLISHED': return 'Событие ещё не опубликовано. Получить билет пока нельзя.';
      case 'TICKET_NOT_FOUND': return 'Билет не найден или принадлежит другому посетителю.';
    }
  }
  return getErrorMessage(error);
}
