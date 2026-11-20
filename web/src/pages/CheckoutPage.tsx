import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { parseEventId, readEventDetails } from '../events/details';
import type { EventDetails } from '../events/details';
import { DEMO_NOTICE, orderError, readOrder } from '../orders/model';
import { ticketTypePrice, ticketTypeUnavailable } from '../ticket-types/model';
import { useTicketTypeClock } from '../ticket-types/useTicketTypeClock';
import { ApiError } from '../api';
import { authLink } from '../auth/returnTo';
import { usePromoQuote } from '../campaigns/usePromoQuote';

export function CheckoutPage() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const { user } = useAuth();
  return <Page eyebrow="Покупка билета" title="Демо-покупка" description={DEMO_NOTICE}>
    {!user ? <Link to={authLink('/login', `/events/${id}/checkout?${search.toString()}`)}>Войти</Link>
      : <Checkout key={`${user.id}:${id}:${search}`} token={search.get('campaign') ?? ''} eventId={parseEventId(id)} typeId={parseEventId(search.get('type') ?? undefined)} />}
  </Page>;
}

function Checkout({ eventId, typeId, token }: { eventId: number | null; typeId: number | null; token: string }) {
  const { user, request } = useAuth();
  const navigate = useNavigate();
  const [promo, setPromo] = useState(token);
  const [fromLink, setFromLink] = useState(Boolean(token));
  const quote = usePromoQuote(request, eventId, typeId, promo.trim(), fromLink);
  const missingQuote = !!promo.trim() && !quote?.quote;
  const [event, setEvent] = useState<EventDetails | null>(null);
  const [name, setName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  // Preserve the exact payload on uncertain delivery. Changes require recovering the existing order first.
  const submitted = useRef<{ ticket_type_id: number; attendee_name: string; attendee_email: string; request_id: string; promo_code?: string } | null>(null);
  const time = useTicketTypeClock(event?.ticket_types);
  const kind = event?.ticket_types?.find((value) => value.id === typeId);
  const unavailable = kind ? ticketTypeUnavailable(kind, time, event?.paid_sales_available) : 'Тип не найден.';
  useEffect(() => {
    if (eventId === null || typeId === null) { setError('Событие или тип не найден.'); return; }
    const controller = new AbortController();
    request(`/events/${eventId}`, { signal: controller.signal }).then((value) => readEventDetails(value, eventId))
      .then((value) => { if (!controller.signal.aborted) setEvent(value); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(orderError(failure)); });
    return () => controller.abort();
  }, [eventId, typeId, request]);
  async function submit() {
    if (guard.current || !kind || !event || (missingQuote && !submitted.current)) return;
    const reason = ticketTypeUnavailable(kind, Date.now(), event.paid_sales_available);
    if (reason && !submitted.current) { setError(reason); return; }
    guard.current = true; setBusy(true); setError(null);
    submitted.current ??= { ticket_type_id: kind.id, attendee_name: name.trim(), attendee_email: email.trim(),
      request_id: requestKey.current, ...(quote?.quote ? {promo_code: quote.quote.code} : {}) };
    try {
      const order = readOrder(await request(`/events/${event.id}/orders`, { method: 'POST', body: submitted.current }));
      if (order.event_id !== event.id || order.ticket_type_id !== kind.id) throw new Error('Unexpected order');
      navigate(`/orders/${order.id}`);
    } catch (failure) {
      setError(orderError(failure));
      if (failure instanceof ApiError && (failure.status === 422 || failure.code?.startsWith('PROMO_'))) {
        submitted.current = null;
        requestKey.current = crypto.randomUUID();
      }
    }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {!event && !error && <p role="status">Загружаем событие…</p>}
    {event && <form className="auth-form content-card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>1. Данные посетителя · {event.title}</h2>
      <p>{kind?.name} · {kind && ticketTypePrice(kind.price_tiyn)}</p>
      <p>Один билет на аккаунт. После отмены билета повторная покупка пока недоступна.</p>
      <label htmlFor="checkout-name">Имя посетителя</label>
      <input id="checkout-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} disabled={busy || submitted.current !== null} />
      <label htmlFor="checkout-email">Email посетителя</label>
      <input id="checkout-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy || submitted.current !== null} />
      <label htmlFor="promo">Промокод</label>
      {fromLink ? <div><span>{quote?.quote?.code ?? 'Из ссылки кампании'}</span>{' '}
        <button type="button" disabled={busy || !!submitted.current} onClick={() => { setFromLink(false); setPromo(''); }}>Убрать промокод</button></div>
        : <input id="promo" value={promo} maxLength={20} disabled={busy || !!submitted.current} onChange={e => setPromo(e.target.value)} />}
      {promo.trim() && (quote?.quote ? <p role="status">Код {quote.quote.code} · скидка {ticketTypePrice(quote.quote.discount_tiyn!)} ·
        итого {ticketTypePrice(quote.quote.total_tiyn!)}</p> : <p role={quote?.error ? 'alert' : 'status'}>{quote?.error ?? 'Проверяем скидку…'}</p>)}
      {unavailable && <p>{unavailable}</p>}
      <button className="button" disabled={busy || (!submitted.current && (missingQuote || unavailable !== null || !kind?.price_tiyn || event.status !== 'published'))}>
        {busy ? 'Резервируем…' : submitted.current ? 'Повторить тот же запрос' : 'Продолжить к оплате'}
      </button>
      <p>На следующем шаге сервер покажет итог и зарезервирует место на 15 минут.</p>
      <Link to="/orders">Проверить мои заказы</Link>
    </form>}
  </>;
}
