import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { readTicket, readTickets, ticketErrorMessage } from '../tickets/model';
import type { EventDetails } from './details';
import { ticketTypePrice, ticketTypeUnavailable } from '../ticket-types/model';
import { useTicketTypeClock } from '../ticket-types/useTicketTypeClock';

export interface EventActionsProps {
  event: EventDetails;
  /** null means availability is unknown, not sold out. */
  remainingSeats: number | null;
  /** Sanitized path to return to after login. */
  returnTo: string;
}

/** Sanjar's integration point: existing tickets remain accessible when full/cancelled. */
export function EventActions(props: EventActionsProps) {
  const { user } = useAuth();
  const t = useT();
  return user ? <VisitorActions key={`${user.id}:${props.event.id}`} {...props} />
    : <p><Link className="button" to={authLink('/login', props.returnTo)}>
      {props.event.status === 'published' && props.remainingSeats !== 0
        ? t.event.loginToClaim : t.event.loginToCheck}
    </Link></p>;
}

function VisitorActions({ event, remainingSeats }: EventActionsProps) {
  const t = useT();
  const { request } = useAuth();
  const navigate = useNavigate();
  const [ticketId, setTicketId] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const types = event.ticket_types;
  const time = useTicketTypeClock(types);
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const choices = types?.map((type) => ({ type, unavailable: ticketTypeUnavailable(type, time) }));
  const availableChoices = choices?.filter(({ unavailable }) => unavailable === null);
  const selected = selectedTypeId === null && availableChoices?.length === 1
    ? availableChoices[0] : choices?.find(({ type }) => type.id === selectedTypeId);
  const typeUnavailable = types !== undefined && (!selected || selected.unavailable !== null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setError(null);
    request<unknown>('/tickets/me', { signal: controller.signal }).then(readTickets)
      .then((tickets) => { if (!controller.signal.aborted) setTicketId(tickets.find((ticket) => ticket.event_id === event.id)?.id ?? null); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(ticketErrorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [event.id, request, attempt]);
  useEffect(() => () => { inFlight.current?.abort(); }, []);

  async function claim() {
    if (inFlight.current || (types !== undefined && !selected)) return;
    const unavailableNow = selected ? ticketTypeUnavailable(selected.type) : null;
    if (unavailableNow !== null) {
      setError(unavailableNow);
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    setClaiming(true);
    setError(null);
    try {
      // Server handles both a new claim (201) and an existing ticket (200).
      const ticket = readTicket(await request(`/events/${event.id}/tickets`, { method: 'POST', signal: controller.signal,
        ...(selected ? { body: { ticket_type_id: selected.type.id } } : {}) }), undefined, event.id);
      if (!controller.signal.aborted) navigate(`/tickets/${ticket.id}`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(ticketErrorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setClaiming(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  if (checking) return <p role="status">{t.event.checkingTickets}</p>;
  if (ticketId !== null) return <p><Link className="button" to={`/tickets/${ticketId}`}>{t.event.openMyTicket}</Link></p>;
  return <div className="ticket-actions" aria-busy={claiming}>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {choices !== undefined && event.status === 'published' && <fieldset className="ticket-type-selection" disabled={claiming}>
      <legend>{t.event.chooseType}</legend>
      {choices.map(({ type, unavailable }) => <label key={type.id}>
        <input type="radio" name={`ticket-type-${event.id}`} value={type.id} checked={type.id === selected?.type.id}
          disabled={unavailable !== null} onChange={() => setSelectedTypeId(type.id)} />
        <span>{type.name}{t.event.typeLine(ticketTypePrice(type.price_tiyn), type.remaining)}
          {unavailable && <small>{unavailable}</small>}</span>
      </label>)}
      {choices.length === 0 && <p>{t.event.noTypeChoices}</p>}
      {choices.some(({ type }) => type.price_tiyn > 0) && <p className="field-hint">{t.event.paidHint}</p>}
    </fieldset>}
    {event.status === 'published' && remainingSeats !== 0 && <button className="button" type="button" disabled={claiming || typeUnavailable}
      onClick={() => { void claim(); }}>{claiming ? t.event.claiming : t.event.claim}</button>}
    {event.status === 'published' && remainingSeats === 0 && <p>{t.event.allClaimed}</p>}
    {event.status !== 'published' && <p>{t.event.noNewTickets}</p>}
    {error && <button className="text-button" type="button" disabled={claiming} onClick={() => setAttempt((value) => value + 1)}>{t.event.checkMyTickets}</button>}
    <p><Link className="text-link" to="/tickets">{t.common.myTickets}</Link></p>
  </div>;
}
