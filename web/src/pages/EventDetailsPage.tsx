import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, getErrorMessage } from '../api';
import { Page } from '../components/Page';
import { useAuth } from '../auth/AuthProvider';
import { authLink, safeReturnTo } from '../auth/returnTo';
import { formatEventDate } from '../events/catalog';
import { eventStatusLabel, parseEventId, readEventDetails, remainingSeats } from '../events/details';
import type { EventDetails } from '../events/details';
import { EventActions } from '../events/EventActions';
import { ticketTypePrice, ticketTypeUnavailable } from '../ticket-types/model';
import { useTicketTypeClock } from '../ticket-types/useTicketTypeClock';

type DetailsState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; event: EventDetails };

export function EventDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const { user, request } = useAuth();
  // Reset state synchronously on route/session changes, before any new effect runs.
  return <EventContent key={`${id}:${user?.id ?? 'guest'}`} id={id} request={user ? request : api.request} guest={!user} />;
}

function EventContent({ id, request, guest }: { id: string | undefined; request: typeof api.request; guest: boolean }) {
  const { user } = useAuth();
  const eventId = parseEventId(id);
  const returnTo = safeReturnTo(`/events/${id}`);
  const [state, setState] = useState<DetailsState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (eventId === null) return;
    const controller = new AbortController();
    request<unknown>(`/events/${eventId}`, { signal: controller.signal })
      .then((payload) => readEventDetails(payload, eventId))
      .then((event) => {
        if (!controller.signal.aborted) setState({ kind: 'success', event });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState(error instanceof ApiError && error.status === 404
          ? { kind: 'not-found' }
          : { kind: 'error', message: getErrorMessage(error) });
      });
    return () => controller.abort();
  }, [eventId, request, attempt]);

  function retry() {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  const notFound = eventId === null || state.kind === 'not-found';
  const event = !notFound && state.kind === 'success' ? state.event : null;
  const available = event ? remainingSeats(event.capacity, event.tickets_issued) : null;
  const salesTime = useTicketTypeClock(event?.ticket_types);

  return (
    <Page
      eyebrow={`Событие · ${id ?? ''}`}
      title={event?.title ?? (notFound ? 'Событие не найдено' : 'Подробнее о событии')}
      description="Дата, место и информация о событии."
    >
      {notFound ? (
        <p role="status">Такого события нет или оно недоступно для просмотра.</p>
      ) : state.kind === 'loading' ? (
        <p role="status">Загружаем событие…</p>
      ) : state.kind === 'error' ? (
        <div className="notice notice-error event-details-error" role="alert">
          <h2>Не удалось загрузить событие</h2>
          <p>{state.message}</p>
          <button className="button" type="button" onClick={retry}>Повторить</button>
        </div>
      ) : event && (
        <article className="content-card event-details">
          {event.status === 'cancelled' && <div className="notice notice-error" role="status">Событие отменено. Новые билеты недоступны.</div>}
          {event.status === 'draft' && <div className="notice" role="status">Событие ещё не опубликовано.</div>}
          <h2>О событии</h2>
          <p className="event-description">{event.description?.trim() ? event.description : 'Описание пока не добавлено.'}</p>
          <dl className="event-facts">
            <dt>Когда</dt>
            <dd><time dateTime={event.date}>{formatEventDate(event.date)}</time><span className="field-hint"> — ваше местное время</span></dd>
            <dt>Где</dt><dd>{event.location}</dd>
            <dt>Статус</dt><dd>{eventStatusLabel(event.status)}</dd>
            <dt>Доступность</dt>
            <dd>{available === null ? 'Доступность неизвестна' : `Осталось мест: ${available}`}</dd>
          </dl>
          {available === 0 && <p role="status">Свободных мест нет.</p>}
          {event.ticket_types !== undefined && <section className="public-ticket-types" aria-label="Типы билетов">
            <h2>Типы билетов</h2>
            {event.ticket_types.length ? <ul>{event.ticket_types.map((type) => {
              const unavailable = ticketTypeUnavailable(type, salesTime);
              return <li key={type.id}>
                <strong>{type.name}</strong> — {ticketTypePrice(type.price_tiyn)} · осталось {type.remaining}
                {type.description && <p>{type.description}</p>}
                {unavailable && <p className="field-hint">{unavailable}</p>}
              </li>;
            })}</ul> : <p>Доступных типов пока нет.</p>}
          </section>}
          {/* Do not hide/disable this slot when full: an existing ticket may still be opened. */}
          <EventActions event={event} remainingSeats={available} returnTo={returnTo} />
          {user && (user.role === 'admin' || user.id === event.organizer_id) && <p>
            <Link className="text-link" to={`/organizer/events/${event.id}/ticket-types`}>Управлять типами билетов</Link>
          </p>}
        </article>
      )}
      <div className="event-navigation">
        <Link className="button" to="/events">Вернуться к событиям</Link>
        {guest && eventId !== null && <p><Link className="text-link" to={authLink('/login', returnTo)}>Войти и вернуться к этому событию</Link></p>}
      </div>
    </Page>
  );
}
