import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { Link } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { readTickets, ticketErrorMessage, ticketState } from '../tickets/model';
import type { Ticket } from '../tickets/model';

export function TicketsPage() {
  const t = useT().tickets;
  const { user, request } = useAuth();
  return <Page eyebrow={t.eyebrow} title={t.title} description={t.description}>
    {user ? <TicketList key={user.id} request={request} />
      : <p><Link className="button" to={authLink('/login', '/tickets')}>{t.loginToSee}</Link></p>}
  </Page>;
}

function TicketList({ request }: { request: typeof api.request }) {
  const t = useT();
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
    <button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>{t.common.retry}</button></div>;
  if (tickets === null) return <p role="status">{t.tickets.loading}</p>;
  if (tickets.length === 0) return <p role="status">{t.tickets.empty}</p>;
  return <ul className="event-grid" aria-label={t.tickets.title}>
    {tickets.map((ticket) => <li key={ticket.id}><article className="content-card event-card">
      <h2><Link className="text-link" to={`/tickets/${ticket.id}`}>{ticket.event.title}</Link></h2>
      <p><time dateTime={ticket.event.date}>{formatEventDate(ticket.event.date)}</time></p>
      <p>{ticket.event.location}</p>
      <p>{ticketState(ticket).label}</p>
      <Link className="button" to={`/tickets/${ticket.id}`}>{t.tickets.open(ticket.id)}</Link>
    </article></li>)}
  </ul>;
}
