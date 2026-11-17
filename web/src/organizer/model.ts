import { ApiError } from '../api/client.ts';

export type OrganizerEventStatus = 'draft' | 'published' | 'cancelled';

/** The fields the organizer dashboard reads from GET /events/mine. */
export interface OrganizerEvent {
  id: number;
  title: string;
  date: string;
  location: string;
  status: OrganizerEventStatus;
  capacity: number;
  tickets_issued: number;
}

const STATUSES: readonly string[] = ['draft', 'published', 'cancelled'];

export const statusLabel: Record<OrganizerEventStatus, string> = {
  draft: 'Черновик',
  published: 'Опубликовано',
  cancelled: 'Отменено',
};

/** Only organizers may open the dashboard: GET /events/mine answers 403 to everyone else. */
export function canUseOrganizerPage(role: string | undefined): boolean {
  return role === 'organizer';
}

export function readOrganizerEvents(payload: unknown): OrganizerEvent[] {
  if (!Array.isArray(payload)) throw invalidList();
  return payload.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw invalidList();
    const event = item as Record<string, unknown>;
    if (
      typeof event.id !== 'number' || !Number.isSafeInteger(event.id) || event.id <= 0 ||
      typeof event.title !== 'string' || !event.title.trim() ||
      typeof event.location !== 'string' ||
      typeof event.date !== 'string' || !Number.isFinite(Date.parse(event.date)) ||
      typeof event.status !== 'string' || !STATUSES.includes(event.status) ||
      typeof event.capacity !== 'number' || typeof event.tickets_issued !== 'number'
    ) {
      throw invalidList();
    }
    return {
      id: event.id,
      title: event.title,
      date: event.date,
      location: event.location,
      status: event.status as OrganizerEventStatus,
      capacity: event.capacity,
      tickets_issued: event.tickets_issued,
    };
  });
}

function invalidList(): ApiError {
  return new ApiError('Сервер вернул некорректный список событий. Попробуйте позже.', { kind: 'response' });
}