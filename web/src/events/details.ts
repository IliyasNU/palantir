import { ApiError } from '../api/client.ts';
import { readTicketTypes } from '../ticket-types/model.ts';
import type { TicketType } from '../ticket-types/model.ts';

export type EventStatus = 'draft' | 'published' | 'cancelled';

/** Normalized EventRead. Unusable counters/status are explicitly unknown. */
export interface EventDetails {
  id: number;
  organizer_id: number;
  title: string;
  description: string | null;
  date: string;
  location: string;
  status: EventStatus | null;
  capacity: number | null;
  tickets_issued: number | null;
  created_at: string;
  updated_at: string;
  /** Absent only when talking to a backend predating ticket types. */
  ticket_types?: TicketType[];
  paid_sales_available?: boolean;
}

export function parseEventId(value: string | undefined): number | null {
  if (!value || value !== value.trim() || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function integer(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

export function remainingSeats(capacity: unknown, ticketsIssued: unknown): number | null {
  const total = integer(capacity, 1);
  const issued = integer(ticketsIssued, 0);
  return total === null || issued === null ? null : Math.max(0, total - issued);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function readEventDetails(payload: unknown, expectedId: number): EventDetails {
  const fail = () => new ApiError('Сервер вернул некорректные данные события. Попробуйте позже.', { kind: 'response' });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail();
  const event = payload as Record<string, unknown>;
  const organizerId = integer(event.organizer_id, 1);
  if (event.id !== expectedId || organizerId === null
    || typeof event.title !== 'string' || !event.title.trim()
    || (event.description !== null && typeof event.description !== 'string')
    || typeof event.location !== 'string'
    || !isDate(event.date) || !isDate(event.created_at) || !isDate(event.updated_at)) throw fail();

  return {
    id: expectedId,
    organizer_id: organizerId,
    title: event.title,
    description: event.description,
    date: event.date,
    location: event.location,
    status: event.status === 'draft' || event.status === 'published' || event.status === 'cancelled' ? event.status : null,
    capacity: integer(event.capacity, 1),
    tickets_issued: integer(event.tickets_issued, 0),
    created_at: event.created_at,
    updated_at: event.updated_at,
    ...(event.ticket_types === undefined ? {} : { ticket_types: readTicketTypes(event.ticket_types, expectedId) }),
    ...(event.paid_sales_available === undefined ? {} : { paid_sales_available: event.paid_sales_available === true }),
  };
}

export function eventStatusLabel(status: EventDetails['status']): string {
  switch (status) {
    case 'draft': return 'Черновик';
    case 'published': return 'Опубликовано';
    case 'cancelled': return 'Отменено';
    default: return 'Неизвестный статус';
  }
}
