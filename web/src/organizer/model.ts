import { ApiError, getErrorMessage } from '../api/client.ts';
import type { ValidationIssue } from '../api/client.ts';
import type { User } from '../auth/types.ts';
import { readEventDetails } from '../events/details.ts';
import type { EventDetails } from '../events/details.ts';
import { current } from '../i18n/index.ts';

/** An event as its organizer or an admin sees it. */
export interface ManagedEvent extends EventDetails {
  /** Suspended by an administrator: hidden from visitors whatever the status. */
  suspended: boolean;
}

export interface EventDraft {
  title: string;
  description: string;
  /** Value of a datetime-local input: local wall time without a zone. */
  date: string;
  location: string;
  capacity: string;
}

/** Creating events and listing one's own is for organizers; the API refuses every other role, admins included. */
export function canOrganize(user: Pick<User, 'role'> | null): boolean {
  return user?.role === 'organizer';
}

/** Editing, publishing and cancelling are for the owner and for admins; the API decides per event. */
export function canManageEvents(user: Pick<User, 'role'> | null): boolean {
  return user?.role === 'organizer' || user?.role === 'admin';
}

export function readManagedEvent(payload: unknown, expectedId: number): ManagedEvent {
  const event = readEventDetails(payload, expectedId);
  const raw = payload as Record<string, unknown>;
  // The admin API reports `suspended`; a `suspended_at` time is accepted as the same fact.
  return { ...event, suspended: raw.suspended === true || (typeof raw.suspended_at === 'string' && raw.suspended_at !== '') };
}

export function readManagedEvents(payload: unknown): ManagedEvent[] {
  const fail = () => new ApiError(current().catalog.malformed, { kind: 'response' });
  if (!Array.isArray(payload)) throw fail();
  return payload.map((item: unknown) => {
    const id = typeof item === 'object' && item !== null && 'id' in item ? item.id : undefined;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw fail();
    return readManagedEvent(item, id);
  });
}

/** UTC instant from the API as the value of a datetime-local input in the browser's zone. */
export function localInputValue(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function emptyEventDraft(): EventDraft {
  return { title: '', description: '', date: '', location: '', capacity: '' };
}

export function eventDraft(event: EventDetails): EventDraft {
  return { title: event.title, description: event.description ?? '', date: localInputValue(event.date),
    location: event.location, capacity: event.capacity === null ? '' : String(event.capacity) };
}

export interface EventPayload {
  title: string;
  description: string | null;
  date: string;
  location: string;
  capacity: number;
}

/**
 * Validates the form with the API's own limits and returns the request body. Local time becomes UTC here.
 * With `original` only the changed fields are returned, so an untouched date is never re-encoded.
 */
export function eventPayload(draft: EventDraft, original?: EventDetails): Partial<EventPayload> {
  const issues: ValidationIssue[] = [];
  const title = draft.title.trim();
  const location = draft.location.trim();
  const description = draft.description.trim();
  const length = (value: string) => [...value].length;
  if (length(title) < 3 || length(title) > 200) issues.push({ field: 'title', message: current().organizer.validation.title });
  if (length(description) > 5000) issues.push({ field: 'description', message: current().organizer.validation.description });
  const sameDate = original !== undefined && draft.date === localInputValue(original.date);
  const time = Date.parse(draft.date);
  if (!sameDate && (!draft.date || !Number.isFinite(time))) issues.push({ field: 'date', message: current().organizer.validation.date });
  if (length(location) < 2 || length(location) > 255) issues.push({ field: 'location', message: current().organizer.validation.location });
  const capacity = /^\d{1,7}$/.test(draft.capacity.trim()) ? Number(draft.capacity.trim()) : Number.NaN;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
    issues.push({ field: 'capacity', message: current().organizer.validation.capacity });
  }
  if (issues.length) throw new ApiError(current().organizer.validation.form, { kind: 'validation', status: 422, issues });

  const payload: EventPayload = { title, description: description || null,
    date: sameDate ? original.date : new Date(time).toISOString(), location, capacity };
  if (!original) return payload;
  const changed: Partial<EventPayload> = {};
  if (payload.title !== original.title) changed.title = payload.title;
  if (payload.description !== (original.description?.trim() || null)) changed.description = payload.description;
  if (!sameDate && Date.parse(payload.date) !== Date.parse(original.date)) changed.date = payload.date;
  if (payload.location !== original.location) changed.location = payload.location;
  if (payload.capacity !== original.capacity) changed.capacity = payload.capacity;
  return changed;
}

/** Message for an event management failure, by the API's error code where it has one. */
export function organizerError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'validation' && error.issues.length === 0) return current().organizer.validation.form;
    switch (error.code) {
      case 'CAPACITY_BELOW_ISSUED': return current().organizer.errors.CAPACITY_BELOW_ISSUED;
      case 'TICKET_TYPES_CAPACITY': return current().organizer.errors.TICKET_TYPES_CAPACITY;
      case 'EVENT_CANCELLED': return current().organizer.errors.EVENT_CANCELLED;
      case 'EVENT_NOT_FOUND': return current().organizer.errors.EVENT_NOT_FOUND;
    }
    if (error.status === 403) return current().organizer.errors.forbidden;
  }
  return getErrorMessage(error);
}
