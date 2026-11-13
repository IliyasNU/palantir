import { useEffect, useState } from 'react';
import { useT } from '../i18n';
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
  const t = useT();
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
      eyebrow={t.event.eyebrow(id ?? '')}
      title={event?.title ?? (notFound ? t.event.notFoundTitle : t.event.fallbackTitle)}
      description={t.event.description}
    >
      {notFound ? (
        <p role="status">{t.event.notFound}</p>
      ) : state.kind === 'loading' ? (
        <p role="status">{t.event.loading}</p>
      ) : state.kind === 'error' ? (
        <div className="notice notice-error event-details-error" role="alert">
          <h2>{t.event.loadFailed}</h2>
          <p>{state.message}</p>
          <button className="button" type="button" onClick={retry}>{t.common.retry}</button>
        </div>
      ) : event && (
        <article className="content-card event-details">
          {event.status === 'cancelled' && <div className="notice notice-error" role="status">{t.event.cancelled}</div>}
          {event.status === 'draft' && <div className="notice" role="status">{t.event.draft}</div>}
          <h2>{t.event.about}</h2>
          <p className="event-description">{event.description?.trim() ? event.description : t.event.noDescription}</p>
          <dl className="event-facts">
            <dt>{t.catalog.when}</dt>
            <dd><time dateTime={event.date}>{formatEventDate(event.date)}</time><span className="field-hint">{t.event.localTime}</span></dd>
            <dt>{t.catalog.where}</dt><dd>{event.location}</dd>
            <dt>{t.event.status}</dt><dd>{eventStatusLabel(event.status)}</dd>
            <dt>{t.event.availability}</dt>
            <dd>{available === null ? t.event.availabilityUnknown : t.event.seatsLeft(available)}</dd>
          </dl>
          {available === 0 && <p role="status">{t.event.soldOut}</p>}
          {event.ticket_types !== undefined && <section className="public-ticket-types" aria-label={t.event.ticketTypes}>
            <h2>{t.event.ticketTypes}</h2>
            {event.ticket_types.length ? <ul>{event.ticket_types.map((type) => {
              const unavailable = ticketTypeUnavailable(type, salesTime);
              return <li key={type.id}>
                <strong>{type.name}</strong>{t.event.typeLine(ticketTypePrice(type.price_tiyn), type.remaining)}
                {type.description && <p>{type.description}</p>}
                {unavailable && <p className="field-hint">{unavailable}</p>}
              </li>;
            })}</ul> : <p>{t.event.noTypes}</p>}
          </section>}
          {/* Do not hide/disable this slot when full: an existing ticket may still be opened. */}
          <EventActions event={event} remainingSeats={available} returnTo={returnTo} />
          {user && (user.role === 'admin' || user.id === event.organizer_id) && <p>
            <Link className="text-link" to={`/organizer/events/${event.id}/ticket-types`}>{t.event.manageTypes}</Link>
          </p>}
        </article>
      )}
      <div className="event-navigation">
        <Link className="button" to="/events">{t.event.backToEvents}</Link>
        {guest && eventId !== null && <p><Link className="text-link" to={authLink('/login', returnTo)}>{t.event.loginAndReturn}</Link></p>}
      </div>
    </Page>
  );
}
