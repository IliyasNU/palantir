import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { parseEventId, readEventDetails } from '../events/details';
import type { EventDetails } from '../events/details';
import { formatOrderAmount, orderError, readOrder } from '../orders/model';
import { ticketTypeUnavailable } from '../ticket-types/model';
import { useTicketTypeClock } from '../ticket-types/useTicketTypeClock';
import { ApiError } from '../api';
import { authLink } from '../auth/returnTo';
import { usePromoQuote } from '../campaigns/usePromoQuote';
import { useT } from '../i18n';

export function CheckoutPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const { user } = useAuth();
  return <Page eyebrow={t.orders.checkout.eyebrow} title={t.orders.checkout.title} description={t.orders.demoNotice}>
    {!user ? <Link to={authLink('/login', `/events/${id}/checkout?${search.toString()}`)}>{t.common.login}</Link>
      : <Checkout key={`${user.id}:${id}:${search}`} token={search.get('campaign') ?? ''} eventId={parseEventId(id)} typeId={parseEventId(search.get('type') ?? undefined)} />}
  </Page>;
}

function Checkout({ eventId, typeId, token }: { eventId: number | null; typeId: number | null; token: string }) {
  const { orders: text } = useT();
  const copy = text.checkout;
  const { user, request } = useAuth();
  const navigate = useNavigate();
  const [promo, setPromo] = useState(token);
  const [fromLink, setFromLink] = useState(Boolean(token));
  const quote = usePromoQuote(request, eventId, typeId, promo.trim(), fromLink);
  const offer = quote && 'quote' in quote ? quote.quote : null;
  const quoteError = quote && 'error' in quote ? quote.error : null;
  const missingQuote = !!promo.trim() && !offer;
  const [event, setEvent] = useState<EventDetails | null>(null);
  const [name, setName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  // Preserve the exact payload on uncertain delivery. Changes require recovering the existing order first.
  const submitted = useRef<{ ticket_type_id: number; attendee_name: string; attendee_email: string; request_id: string; promo_code?: string } | null>(null);
  const time = useTicketTypeClock(event?.ticket_types);
  const kind = event?.ticket_types?.find((value) => value.id === typeId);
  const unavailable = kind ? ticketTypeUnavailable(kind, time, event?.paid_sales_available) : copy.noType;
  useEffect(() => {
    if (eventId === null || typeId === null) return;
    const controller = new AbortController();
    request(`/events/${eventId}`, { signal: controller.signal }).then((value) => readEventDetails(value, eventId))
      .then((value) => { if (!controller.signal.aborted) setEvent(value); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [eventId, typeId, request]);
  async function submit() {
    if (guard.current || !kind || !event || (missingQuote && !submitted.current)) return;
    const reason = ticketTypeUnavailable(kind, Date.now(), event.paid_sales_available);
    if (reason && !submitted.current) return;
    guard.current = true; setBusy(true); setError(null);
    submitted.current ??= { ticket_type_id: kind.id, attendee_name: name.trim(), attendee_email: email.trim(),
      request_id: requestKey.current, ...(offer ? {promo_code: offer.code} : {}) };
    try {
      const order = readOrder(await request(`/events/${event.id}/orders`, { method: 'POST', body: submitted.current }));
      if (order.event_id !== event.id || order.ticket_type_id !== kind.id) throw new ApiError((m) => m.orders.malformed, {kind: 'response'});
      navigate(`/orders/${order.id}`);
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError && (failure.status === 422 || failure.code?.startsWith('PROMO_'))) {
        submitted.current = null;
        requestKey.current = crypto.randomUUID();
      }
    }
    finally { guard.current = false; setBusy(false); }
  }
  if (eventId === null || typeId === null) return <p role="alert">{copy.notFound}</p>;
  return <>
    {error != null && <p role="alert" className="notice notice-error">{orderError(error)}</p>}
    {!event && error == null && <p role="status">{copy.loading}</p>}
    {event && <form className="auth-form content-card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>{copy.attendee(event.title)}</h2>
      {kind && <p>{kind.name} · {formatOrderAmount(kind.price_tiyn)}</p>}
      <p>{copy.singleTicket}</p>
      <div><h3>{text.policy}</h3><p className="event-description">{event.refund_policy || text.noPolicy}</p></div>
      <label htmlFor="checkout-name">{copy.name}</label>
      <input id="checkout-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} disabled={busy || submitted.current !== null} />
      <label htmlFor="checkout-email">{copy.email}</label>
      <input id="checkout-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy || submitted.current !== null} />
      {fromLink ? <div><span>{offer?.code ?? copy.fromCampaign}</span>{' '}
        <button type="button" disabled={busy || !!submitted.current} onClick={() => { setFromLink(false); setPromo(''); }}>{copy.removePromo}</button></div>
        : <><label htmlFor="promo">{copy.promo}</label>
          <input id="promo" value={promo} maxLength={20} disabled={busy || !!submitted.current} onChange={e => setPromo(e.target.value)} /></>}
      {promo.trim() && (offer && offer.discount_tiyn !== null && offer.total_tiyn !== null
        ? <p role="status">{copy.quote(offer.code, formatOrderAmount(offer.discount_tiyn), formatOrderAmount(offer.total_tiyn))}</p>
        : <p role={quoteError != null ? 'alert' : 'status'}>{quoteError != null ? orderError(quoteError) : copy.checking}</p>)}
      {unavailable && <p>{unavailable}</p>}
      <button className="button" disabled={busy || (!submitted.current && (missingQuote || unavailable !== null || !kind?.price_tiyn || event.status !== 'published'))}>
        {busy ? copy.reserving : submitted.current ? copy.retry : copy.continue}
      </button>
      <p>{copy.next}</p>
      <Link to="/orders">{text.showMine}</Link>
    </form>}
  </>;
}
