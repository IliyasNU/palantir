import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { readTickets, ticketErrorMessage } from '../tickets/model';
import type { Ticket } from '../tickets/model';

export function TicketsPage() {
  const { user, request } = useAuth();
  return <Page eyebrow="Ваши события" title="Мои билеты" description="Откройте билет и покажите его QR-код на входе.">
    {user ? <TicketList key={user.id} request={request} />
      : <p><Link className="button" to={authLink('/login', '/tickets')}>Войти, чтобы увидеть билеты</Link></p>}
  </Page>;
}

function TicketList({ request }: { request: typeof api.request }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTickets(null);
    setError(null);
    request('/tickets/me', { signal: controller.signal }).then(readTickets)
      .then((result) => { if (!controller.signal.aborted) setTickets(result); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(ticketErrorMessage(failure)); });
    return () => controller.abort();
  }, [request, attempt]);
  if (error) return <div className="notice notice-error" role="alert"><p>{error}</p>
    <button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>Повторить</button></div>;
  if (tickets === null) return <p role="status">Загружаем билеты…</p>;
  if (tickets.length === 0) return <p role="status">Билетов пока нет. Выберите событие и получите бесплатный билет.</p>;
  return <ul className="event-grid" aria-label="Мои билеты">
    {tickets.map((ticket) => <li key={ticket.id}><article className="content-card event-card">
      <h2><Link className="text-link" to={`/tickets/${ticket.id}`}>{ticket.event.title}</Link></h2>
      <p><time dateTime={ticket.event.date}>{formatEventDate(ticket.event.date)}</time></p>
      <p>{ticket.event.location}</p>
      <p>{ticket.event.status === 'cancelled' ? 'Событие отменено' : ticket.checked_in_at ? 'Билет уже использован'
        : ticket.event.status === 'published' ? 'Билет готов к входу' : 'Вход по билету сейчас недоступен'}</p>
      <Link className="button" to={`/tickets/${ticket.id}`}>Открыть билет №{ticket.id}</Link>
    </article></li>)}
  </ul>;
}
