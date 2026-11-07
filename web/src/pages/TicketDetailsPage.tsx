import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { parseEventId } from '../events/details';
import { readTicket, ticketErrorMessage } from '../tickets/model';
import type { Ticket } from '../tickets/model';
import { TicketQr } from '../tickets/TicketQr';

export function TicketDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const ticketId = parseEventId(id);
  const { user, request } = useAuth();
  return <Page eyebrow="Ваш билет" title="Билет BiletFlow" description="QR-код проверяет сотрудник на входе.">
    {ticketId === null ? <p role="status">Билет не найден.</p>
      : !user ? <p><Link className="button" to={authLink('/login', `/tickets/${ticketId}`)}>Войти и открыть билет</Link></p>
        : <TicketContent key={`${user.id}:${ticketId}`} id={ticketId} request={request} />}
    <p><Link className="text-link" to="/tickets">Все мои билеты</Link></p>
  </Page>;
}

function TicketContent({ id, request }: { id: number; request: typeof api.request }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTicket(null);
    setError(null);
    setNotFound(false);
    request(`/tickets/${id}`, { signal: controller.signal }).then((payload) => readTicket(payload, id))
      .then((result) => { if (!controller.signal.aborted) setTicket(result); })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 404) setNotFound(true);
        else setError(ticketErrorMessage(failure));
      });
    return () => controller.abort();
  }, [id, request, attempt]);
  if (notFound) return <p role="status">Билет не найден или принадлежит другому посетителю.</p>;
  if (error) return <div className="notice notice-error" role="alert"><p>{error}</p>
    <button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>Повторить</button></div>;
  if (!ticket) return <p role="status">Загружаем билет…</p>;
  const usable = ticket.event.status === 'published' && ticket.checked_in_at === null;
  return <article className="content-card ticket-details">
    <h2>{ticket.event.title}</h2>
    <p>Билет №{ticket.id}</p>
    <p><time dateTime={ticket.event.date}>{formatEventDate(ticket.event.date)}</time></p>
    <p>{ticket.event.location}</p>
    {ticket.event.status === 'cancelled' && <p className="notice notice-error" role="status">Событие отменено. Этот билет не даёт права на вход.</p>}
    {ticket.checked_in_at && <p className="notice" role="status">Билет уже использован: {formatEventDate(ticket.checked_in_at)}.</p>}
    {usable && <><TicketQr payload={ticket.qr_payload} /><p>Покажите этот QR-код сотруднику. Не публикуйте его и не передавайте другим людям.</p></>}
    {!usable && !ticket.checked_in_at && ticket.event.status !== 'cancelled' && <p role="status">Билет сейчас недоступен для входа.</p>}
    <Link className="text-link" to={`/events/${ticket.event_id}`}>Открыть событие</Link>
  </article>;
}
