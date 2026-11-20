import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { parseEventId } from '../events/details';
import { useLocale, useT } from '../i18n';
import { historyPageSize, readDuplicate, readEventHistory, readEventTimeline } from '../organizer/history';
import { historyCopy } from '../organizer/history-copy';
import { canManageEvents, eventPhase, isClosedPhase, organizerError } from '../organizer/model';
import { ticketTypePrice } from '../ticket-types/model';
import { OrganizerGate } from './OrganizerPage';

export function EventHistoryPage() {
  const { id } = useParams();
  const eventId = parseEventId(id);
  const { user } = useAuth();
  const text = useT().organizer;
  const copy = historyCopy[useLocale()];
  const allowed = canManageEvents(user);
  return <Page eyebrow={text.eyebrow} title={copy.title} description={copy.unavailable}>
    {eventId === null ? <p role="status">{text.editor.notFound}</p>
      : !allowed ? <OrganizerGate allowed={false} returnTo={`/organizer/events/${eventId}/history`} />
        : <History key={`${user?.id}:${eventId}`} id={eventId} />}
    <p><Link className="text-link" to="/organizer">{text.editor.backToList}</Link></p>
  </Page>;
}

type Load = { kind: 'loading' } | { kind: 'error'; error: unknown }
  | { kind: 'ready'; data: ReturnType<typeof readEventHistory>; timeline: ReturnType<typeof readEventTimeline> };

function History({ id }: { id: number }) {
  const { request } = useAuth();
  const text = useT().organizer;
  const copy = historyCopy[useLocale()];
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const offset = page * historyPageSize;

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    async function fetchHistory() {
      const data = readEventHistory(await request(`/events/${id}/history?limit=${historyPageSize}&offset=${offset}`, options), id);
      const timeline = isClosedPhase(eventPhase(data.event))
        ? readEventTimeline(await request(`/events/${id}/action-log?limit=${historyPageSize + 1}&offset=${offset}`, options)) : [];
      if (!controller.signal.aborted) setLoad({ kind: 'ready', data, timeline });
    }
    void fetchHistory().catch((error: unknown) => {
      if (!controller.signal.aborted) setLoad({ kind: 'error', error });
    });
    return () => controller.abort();
  }, [request, id, offset, attempt]);

  if (load.kind === 'loading') return <p role="status">{text.editor.loading}</p>;
  if (load.kind === 'error') return <div className="notice notice-error">
    <p role="alert">{organizerError(load.error)}</p>
    <button type="button" className="text-button" onClick={() => {
      setLoad({ kind: 'loading' }); setAttempt(value => value + 1);
    }}>{text.list.retry}</button>
  </div>;

  const { event, tickets, orders, checkIns, hasMore } = load.data;
  const phase = eventPhase(event);
  if (!isClosedPhase(phase)) return <p role="status">{copy.unavailable}</p>;
  const changePage = (next: number) => { setLoad({ kind: 'loading' }); setPage(next); };
  const typeNames = new Map(event.ticket_types?.map(type => [type.id, type.name]));

  return <div className="event-history">
    <section className="content-card" aria-label={copy.details}>
      <h2>{event.title}</h2>
      <p>{copy.state[phase]} · {copy.readOnly}</p>
      <p><DateTime value={event.date} /> · {event.location}</p>
      {event.description && <p>{event.description}</p>}
      {!event.suspended && <DuplicateForm id={id} />}
    </section>
    <HistoryList title={copy.tickets} empty={tickets.length === 0}>
      {tickets.map(row => <li key={row.id}>{copy.ticketNumber(row.id)} · {typeNames.get(row.typeId) ?? copy.typeNumber(row.typeId)}
        {' · '}{copy.ticketStatuses[row.status]} · <DateTime value={row.created} /></li>)}
    </HistoryList>
    <HistoryList title={copy.orders} empty={orders.length === 0}>
      {orders.map(row => <li key={row.id}>{copy.orderNumber(row.id)} · {copy.orderStatuses[row.status]}
        {' · '}{ticketTypePrice(row.total)} · <DateTime value={row.created} /></li>)}
    </HistoryList>
    <HistoryList title={copy.checkIns} empty={checkIns.length === 0}>
      {checkIns.map(row => <li key={row.id}>{copy.ticketNumber(row.ticketId)} · {copy.checkedIn}: <DateTime value={row.checkedIn} />
        {row.undone && <> · {copy.undone}: <DateTime value={row.undone} /></>}</li>)}
    </HistoryList>
    <HistoryList title={copy.timeline} empty={load.timeline.length === 0}>
      {load.timeline.slice(0, historyPageSize).map(row => <li key={row.id}><DateTime value={row.occurred_at} />
        {' · '}{row.actor_name} · {row.action}<br />{row.description}</li>)}
    </HistoryList>
    <div className="organizer-links">
      <button type="button" className="button button-secondary" disabled={page === 0}
        onClick={() => changePage(page - 1)}>{copy.previous}</button>
      <span>{copy.page(page + 1)}</span>
      <button type="button" className="button button-secondary" disabled={!hasMore && load.timeline.length <= historyPageSize}
        onClick={() => changePage(page + 1)}>{copy.next}</button>
    </div>
  </div>;
}

function DateTime({ value }: { value: string }) {
  return <time dateTime={value}>{formatEventDate(value)}</time>;
}

function HistoryList({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  const copy = historyCopy[useLocale()];
  return <section className="content-card" aria-label={title}>
    <h2>{title}</h2>
    {empty ? <p>{copy.none}</p> : <ul>{children}</ul>}
  </section>;
}

function DuplicateForm({ id }: { id: number }) {
  const { request } = useAuth();
  const navigate = useNavigate();
  const copy = historyCopy[useLocale()];
  const { submit, pending, error } = useSubmission();
  const [invalid, setInvalid] = useState(false);

  function duplicate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const timestamp = Date.parse(String(new FormData(event.currentTarget).get('date') ?? ''));
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) { setInvalid(true); return; }
    setInvalid(false);
    void submit(async signal => {
      const result = await request(`/events/${id}/duplicate`, {
        method: 'POST', body: { date: new Date(timestamp).toISOString() }, signal,
      });
      const draft = readDuplicate(result, id);
      if (!signal.aborted) navigate(`/organizer/events/${draft.id}/edit`, { state: { created: true } });
    });
  }

  return <form className="auth-form" onSubmit={duplicate}>
    <p>{copy.duplicateHelp}</p>
    <label htmlFor="duplicate-event-date">{copy.date}</label>
    <input id="duplicate-event-date" name="date" type="datetime-local" required disabled={pending} />
    {invalid && <p role="alert">{copy.future}</p>}
    {error !== null && !invalid && <p role="alert">{organizerError(error)}</p>}
    <button className="button" type="submit" disabled={pending}>{pending ? copy.duplicating : copy.duplicate}</button>
  </form>;
}
