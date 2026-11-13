import { ApiError, getErrorMessage } from '../api/client.ts';
import type { User } from '../auth/types.ts';
import { readEventDetails } from '../events/details.ts';
import type { EventDetails } from '../events/details.ts';
import { adminText as text } from './strings.ts';

export const SEARCH_LIMIT = 50; // the API's maximum for user and event search
export const LOG_PAGE = 50;
/** Marks a problem found in the form before any request; its message is already written for the user. */
const FORM = 'FORM';

export interface AdminUser {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

export interface AdminEvent extends EventDetails {
  suspended_at: string | null;
}

export interface ActionLogEntry {
  id: number;
  event_id: number | null;
  occurred_at: string;
  actor_id: number;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: number;
  description: string;
}

export function isAdmin(user: Pick<User, 'role'> | null): boolean {
  return user?.role === 'admin';
}

const malformed = () => new ApiError('Сервер вернул некорректные данные. Попробуйте позже.', { kind: 'response' });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function readAdminUser(payload: unknown): AdminUser {
  if (!record(payload) || !id(payload.id) || typeof payload.email !== 'string' || typeof payload.full_name !== 'string'
    || typeof payload.role !== 'string' || typeof payload.is_active !== 'boolean' || !time(payload.created_at)) throw malformed();
  return { id: payload.id, email: payload.email, full_name: payload.full_name, role: payload.role,
    is_active: payload.is_active, created_at: payload.created_at };
}

export function readAdminEvent(payload: unknown): AdminEvent {
  if (!record(payload) || !id(payload.id) || !(payload.suspended_at === null || time(payload.suspended_at))) throw malformed();
  return { ...readEventDetails(payload, payload.id), suspended_at: payload.suspended_at };
}

export function readActionLogEntry(payload: unknown): ActionLogEntry {
  if (!record(payload) || !id(payload.id) || !(payload.event_id === null || id(payload.event_id)) || !time(payload.occurred_at)
    || !id(payload.actor_id) || typeof payload.actor_name !== 'string' || typeof payload.action !== 'string'
    || typeof payload.entity_type !== 'string' || !id(payload.entity_id) || typeof payload.description !== 'string') throw malformed();
  return { id: payload.id, event_id: payload.event_id, occurred_at: payload.occurred_at, actor_id: payload.actor_id,
    actor_name: payload.actor_name, action: payload.action, entity_type: payload.entity_type, entity_id: payload.entity_id,
    description: payload.description };
}

export function readList<T>(payload: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(payload)) throw malformed();
  return payload.map(read);
}

/** Path with only the filters that have a value. */
export function adminPath(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** The trimmed reason, checked against the API's limits before the request. */
export function suspensionReason(value: string): string {
  const reason = value.trim();
  const length = [...reason].length;
  if (length < 3 || length > 300) {
    throw new ApiError(text.reasonInvalid, { kind: 'validation', status: 422, code: FORM });
  }
  return reason;
}

export interface LogFilters {
  action: string;
  eventId: string;
  /** Values of datetime-local inputs in the browser's zone. */
  from: string;
  to: string;
}

/** Query of GET /admin/action-log for one page; local times become UTC. */
export function actionLogPath(filters: LogFilters, offset: number): string {
  const eventId = filters.eventId.trim();
  if (eventId && !/^[1-9]\d{0,9}$/.test(eventId)) throw new ApiError(text.log.eventIdInvalid, { kind: 'validation', status: 422, code: FORM });
  const instant = (value: string) => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new ApiError(text.log.periodInvalid, { kind: 'validation', status: 422, code: FORM });
    return new Date(parsed).toISOString();
  };
  const from = instant(filters.from);
  const to = instant(filters.to);
  if (from && to && from > to) throw new ApiError(text.log.periodInvalid, { kind: 'validation', status: 422, code: FORM });
  return adminPath('/admin/action-log', { action: filters.action.trim(), event_id: eventId, date_from: from, date_to: to, limit: LOG_PAGE, offset });
}

/** Message for an admin request failure, by the API's error code where it has one. */
export function adminError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'USER_NOT_FOUND': return text.errors.USER_NOT_FOUND;
      case 'EVENT_NOT_FOUND': return text.errors.EVENT_NOT_FOUND;
      case 'CANNOT_SUSPEND_SELF': return text.errors.CANNOT_SUSPEND_SELF;
    }
    if (error.code === FORM) return error.message;
    if (error.status === 403) return text.errors.forbidden;
    if (error.status === 422) return text.errors.invalid;
  }
  return getErrorMessage(error);
}

export function roleLabel(role: string): string {
  return Object.hasOwn(text.roles, role) ? text.roles[role as keyof typeof text.roles] : role;
}
