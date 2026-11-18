import { useEffect, useRef, useState } from 'react';
import { current, useT } from '../i18n';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { parseEventId } from '../events/details';
import { ticketTypeNamePolicy } from '../ticket-types/model';
import { readTicket, ticketErrorMessage, ticketPdfName, ticketState } from '../tickets/model';
import type { Ticket } from '../tickets/model';
import { TicketQr } from '../tickets/TicketQr';

export function TicketDetailsPage() {
  const t = useT().tickets;
  const { id } = useParams<{ id: string }>();
  const ticketId = parseEventId(id);
  const { user, request } = useAuth();
  return <Page eyebrow={t.detailsEyebrow} title={t.detailsTitle} description={t.detailsDescription}>
    {ticketId === null ? <p role="status">{t.notFound}</p>
      : !user ? <p><Link className="button" to={authLink('/login', `/tickets/${ticketId}`)}>{t.loginToOpen}</Link></p>
        : <TicketContent key={`${user.id}:${ticketId}`} id={ticketId} request={request} />}
    <p><Link className="text-link" to="/tickets">{t.all}</Link></p>
  </Page>;
}

function TicketContent({ id, request }: { id: number; request: typeof api.request }) {
  const t = useT().tickets;
  const retryLabel = useT().common.retry;
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
  if (notFound) return <p role="status">{t.notFoundOrForeign}</p>;
  if (error) return <div className="notice notice-error" role="alert"><p>{error}</p>
    <button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>{retryLabel}</button></div>;
  if (!ticket) return <p role="status">{t.loadingOne}</p>;
  const { usable, printable, cancellable } = ticketState(ticket);
  const closed = ticket.status !== 'active';
  return <article className="content-card ticket-details">
    <h2>{ticket.event.title}</h2>
    <p>{t.number(ticket.id)}</p>
      {ticket.ticket_type && <p className="ticket-type-label" title={ticket.ticket_type.name}
        style={{ WebkitLineClamp: ticketTypeNamePolicy.displayLines }}>{t.type(ticket.ticket_type.name)}</p>}
    <p><time dateTime={ticket.event.date}>{formatEventDate(ticket.event.date)}</time></p>
    <p>{ticket.event.location}</p>
    {ticket.status === 'cancelled' && <p className="notice notice-error" role="status">{t.cancelledNotice}</p>}
    {ticket.status === 'refunded' && <p className="notice notice-error" role="status">{t.refundedNotice}</p>}
    {!closed && ticket.event.status === 'cancelled' && <p className="notice notice-error" role="status">{t.eventCancelledNotice}</p>}
    {ticket.checked_in_at && <p className="notice" role="status">{t.used(formatEventDate(ticket.checked_in_at))}</p>}
    {usable && <><TicketQr payload={ticket.qr_payload} /><p>{t.showQr}</p></>}
    {!usable && !closed && !ticket.checked_in_at && ticket.event.status !== 'cancelled' && <p role="status">{t.unavailable}</p>}
    {printable && <TicketPdf id={ticket.id} request={request} />}
    {cancellable && <CancelTicket id={ticket.id} request={request} onCancelled={setTicket} />}
    <Link className="text-link" to={`/events/${ticket.event_id}`}>{t.openEvent}</Link>
  </article>;
}

/** Downloads the server's PDF of this ticket. Its QR is the same one shown above, so paper and screen are one ticket. */
function TicketPdf({ id, request }: { id: number; request: typeof api.request }) {
  const t = useT().tickets;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const file = await request<Blob>(`/tickets/${id}/pdf`, { blob: true });
      if (!mounted.current) return;
      if (file.type !== 'application/pdf' || file.size === 0) throw new ApiError(current().tickets.badFile, { kind: 'response' });
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = ticketPdfName(id);
      document.body.append(link);
      link.click();
      link.remove();
      // Give the browser time to start the download before the object URL is released.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (failure) {
      if (mounted.current) setError(ticketErrorMessage(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="ticket-action">
    <button className="button" type="button" disabled={busy} onClick={() => { void download(); }}>
      {busy ? t.pdfBusy : t.pdf}
    </button>
    <p>{t.pdfHint}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </div>;
}

/** Lets the holder give the ticket up. The server makes it final and frees the seat. */
function CancelTicket({ id, request, onCancelled }: { id: number; request: typeof api.request; onCancelled: (ticket: Ticket) => void }) {
  const t = useT().tickets;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function cancel() {
    if (busy || !window.confirm(t.cancelConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      const result = readTicket(await request(`/tickets/${id}/cancel`, { method: 'POST' }), id);
      if (mounted.current) onCancelled(result);
    } catch (failure) {
      if (mounted.current) { setError(ticketErrorMessage(failure)); setBusy(false); }
    }
  }

  return <div className="ticket-action">
    <button className="button button-secondary" type="button" disabled={busy} onClick={() => { void cancel(); }}>
      {busy ? t.cancelling : t.cancel}
    </button>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </div>;
}
