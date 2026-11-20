import { readActionLogEntry } from '../admin/model.ts';
import { ApiError } from '../api/client.ts';
import { readManagedEvent } from './model.ts';

function malformed(): never {
  throw new ApiError((m) => m.event.malformed, { kind: 'response' });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
}

function number(value: unknown, minimum = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : malformed();
}

function timestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : malformed();
}

function status<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.find(option => option === value) ?? malformed();
}

function list<T>(value: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return malformed();
  return value.map(read);
}

export const historyPageSize = 50;

export function readEventHistory(payload: unknown, id: number) {
  const data = record(payload);
  if (typeof data.has_more !== 'boolean') return malformed();
  return {
    event: readManagedEvent(data.event, id),
    hasMore: data.has_more,
    tickets: list(data.tickets, value => {
      const row = record(value);
      return { id: number(row.id), typeId: number(row.ticket_type_id), created: timestamp(row.created_at),
        status: status(row.status, ['active', 'cancelled', 'refunded'] as const) };
    }),
    orders: list(data.orders, value => {
      const row = record(value);
      return { id: number(row.id), total: number(row.total_tiyn, 0), created: timestamp(row.created_at),
        status: status(row.status, ['pending', 'paid', 'failed', 'cancelled', 'expired'] as const) };
    }),
    checkIns: list(data.check_ins, value => {
      const row = record(value);
      return { id: number(row.id), ticketId: number(row.ticket_id), checkedIn: timestamp(row.checked_in_at),
        undone: row.undone_at === null ? null : timestamp(row.undone_at) };
    }),
  };
}

export function readEventTimeline(value: unknown) {
  return list(value, readActionLogEntry);
}

export function readDuplicate(payload: unknown, sourceId: number) {
  const id = number(record(payload).id);
  const event = readManagedEvent(payload, id);
  if (id === sourceId || event.status !== 'draft') return malformed();
  return event;
}
