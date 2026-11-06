import { ApiError } from '../api/client.ts';

/** Fields used by the catalog from the backend's EventRead response. */
export interface CatalogEvent {
  id: number;
  title: string;
  date: string;
  location: string;
}

export function readCatalog(payload: unknown): CatalogEvent[] {
  if (!Array.isArray(payload)) throw invalidCatalog();
  return payload.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw invalidCatalog();
    const event = item as Record<string, unknown>;
    if (typeof event.id !== 'number' || !Number.isSafeInteger(event.id) || event.id <= 0
      || typeof event.title !== 'string' || !event.title.trim()
      || typeof event.location !== 'string'
      || typeof event.date !== 'string' || !Number.isFinite(Date.parse(event.date))) {
      throw invalidCatalog();
    }
    return { id: event.id, title: event.title, date: event.date, location: event.location };
  });
}

function invalidCatalog(): ApiError {
  return new ApiError('Сервер вернул некорректный список событий. Попробуйте позже.', { kind: 'response' });
}

export function filterEventsByTitle(events: CatalogEvent[], query: string): CatalogEvent[] {
  const search = query.trim().toLowerCase();
  return events.filter((event) => event.title.toLowerCase().includes(search));
}

export function formatEventDate(date: string): string {
  // No timeZone override: display the server instant in the browser's local time.
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(date));
}
