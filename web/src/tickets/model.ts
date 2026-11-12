import { ApiError, getErrorMessage } from '../api/client.ts';
import { readTicketTypeSummary, ticketTypeError } from '../ticket-types/model.ts';
import type { TicketTypeSummary } from '../ticket-types/model.ts';

export type TicketStatus = 'active' | 'cancelled' | 'refunded';

export interface Ticket {
  id: number;
  event_id: number;
  attendee_id: number;
  qr_payload: string;
  created_at: string;
  /** Only an active ticket can be admitted. A server without ticket states sends none: such tickets are active. */
  status: TicketStatus;
  checked_in_at: string | null;
  ticket_type_id?: number;
  ticket_type?: TicketTypeSummary;
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
function ticketStatus(value: unknown): value is TicketStatus {
  return value === 'active' || value === 'cancelled' || value === 'refunded';
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
    || (payload.status !== undefined && !ticketStatus(payload.status))
    // A cancelled or refunded ticket is never checked in; showing both would contradict itself.
    || (payload.status !== undefined && payload.status !== 'active' && payload.checked_in_at !== null)
    || !record(payload.event) || payload.event.id !== payload.event_id
    || typeof payload.event.title !== 'string' || !payload.event.title.trim()
    || !date(payload.event.date) || typeof payload.event.location !== 'string' || typeof payload.event.status !== 'string') {
    throw invalidTicket();
  }
  const type = payload.ticket_type === undefined && payload.ticket_type_id === undefined
    ? undefined : readTicketTypeSummary(payload.ticket_type);
  if (type !== undefined && payload.ticket_type_id !== type.id) throw invalidTicket();
  return {
    id: payload.id, event_id: payload.event_id, attendee_id: payload.attendee_id,
    qr_payload: payload.qr_payload, created_at: payload.created_at, status: payload.status ?? 'active',
    checked_in_at: payload.checked_in_at,
    ...(type === undefined ? {} : { ticket_type_id: type.id, ticket_type: type }),
    event: { id: payload.event.id as number, title: payload.event.title, date: payload.event.date,
      location: payload.event.location, status: payload.event.status },
  };
}

export function readTickets(payload: unknown): Ticket[] {
  if (!Array.isArray(payload)) throw invalidTicket();
  return payload.map((ticket) => readTicket(ticket));
}

/** What the visitor may still do with the ticket. */
export function ticketState(ticket: Ticket) {
  const open = ticket.status === 'active' && ticket.event.status !== 'cancelled';
  return {
    /** The QR is shown and scanned at the door. */
    usable: open && ticket.event.status === 'published' && ticket.checked_in_at === null,
    /** The printable PDF exists while the ticket can still stand for an admission, used or not. */
    printable: open,
    /** The holder can give the ticket up before entering. */
    cancellable: ticket.status === 'active' && ticket.checked_in_at === null,
    label: ticket.status === 'cancelled' ? 'Билет отменён' : ticket.status === 'refunded' ? 'Билет возвращён'
      : ticket.event.status === 'cancelled' ? 'Событие отменено' : ticket.checked_in_at ? 'Билет уже использован'
        : ticket.event.status === 'published' ? 'Билет готов к входу' : 'Вход по билету сейчас недоступен',
  };
}

export function ticketPdfName(ticketId: number): string {
  return `biletflow-ticket-${ticketId}.pdf`;
}

export function ticketErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SOLD_OUT': return 'Свободных билетов больше нет. Уже полученные билеты доступны в разделе «Мои билеты».';
      case 'EVENT_CANCELLED': return 'Событие отменено. Уже полученный билет доступен в разделе «Мои билеты».';
      case 'EVENT_NOT_PUBLISHED': return 'Событие ещё не опубликовано. Получить билет пока нельзя.';
      case 'PENDING_ORDER_EXISTS': return 'У вас есть незавершённый платный заказ. Откройте «Мои заказы» и завершите или отмените его.';
      case 'TICKET_NOT_FOUND': return 'Билет не найден или принадлежит другому посетителю.';
      case 'TICKET_CANCELLED': return 'Билет отменён и не даёт права на вход.';
      case 'TICKET_REFUNDED': return 'Билет возвращён и не даёт права на вход.';
      case 'TICKET_CHECKED_IN': return 'По этому билету уже отмечен вход. Отменить его нельзя.';
    }
    if (error.code?.startsWith('TICKET_TYPE_') || error.code === 'PAID_TICKETS_NOT_SUPPORTED') return ticketTypeError(error);
  }
  return getErrorMessage(error);
}
