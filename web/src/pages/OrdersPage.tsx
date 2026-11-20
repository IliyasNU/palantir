import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { formatOrderAmount, orderError, readOrder, readOrders } from '../orders/model';
import type { Order } from '../orders/model';
import { parseEventId } from '../events/details';
import { formatEventDate } from '../events/catalog';
import { ApiError } from '../api';
import { useT } from '../i18n';
import { authLink } from '../auth/returnTo';

export function OrderView({ initial }: { initial: Order }) {
  const t = useT();
  const text = t.orders;
  const { request } = useAuth();
  const [order, setOrder] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const guard = useRef(false);
  async function act(action: 'success' | 'failure' | 'cancel') {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(null);
    try {
      const next = readOrder(await request(`/orders/${order.id}/${action === 'cancel' ? 'cancel' : 'pay'}`, {
        method: 'POST', ...(action === 'cancel' ? {} : { body: { outcome: action } }),
      }));
      if (next.id !== order.id) throw new ApiError((m) => m.orders.malformed, { kind: 'response' });
      setOrder(next);
    } catch (failure) {
      setError(failure);
      // Lost confirmations are recovered from the same order, never a new purchase.
      try { setOrder(readOrder(await request(`/orders/${order.id}`))); } catch { /* retain retry controls */ }
    } finally { guard.current = false; setBusy(false); }
  }
  return <section className="content-card" aria-label={text.orderTitle} aria-busy={busy}>
    <p className="notice">{text.demoNotice}</p>
    <h2>{text.orderNumber(order.id)} · {text.status[order.status]}</h2>
    <p>{order.attendee_name} · {order.attendee_email}</p>
    <p>{text.price(formatOrderAmount(order.subtotal_tiyn))}</p>
    {order.promo_code && <p>{text.promoLine(order.promo_code, formatOrderAmount(order.discount_tiyn ?? 0))}</p>}
    <p>{text.fee(formatOrderAmount(order.processing_fee_tiyn))}</p>
    <p><strong>{text.total(formatOrderAmount(order.total_tiyn))}</strong></p>
    {error != null && <p className="notice notice-error" role="alert">{orderError(error)}</p>}
    {order.status === 'pending' && <>
      <p>{text.reservedUntil(formatEventDate(order.expires_at))}</p>
      <button className="button" disabled={busy} onClick={() => { void act('success'); }}>{text.pay}</button>{' '}
      <button className="text-button" disabled={busy} onClick={() => { void act('failure'); }}>{text.fail}</button>{' '}
      <button className="text-button" disabled={busy} onClick={() => { void act('cancel'); }}>{text.cancelOrder}</button>
    </>}
    {order.status === 'refunded' && order.refunded_at && <p role="status">
      {text.refundedAmount(formatOrderAmount(order.total_tiyn), formatEventDate(order.refunded_at))}
    </p>}
    {order.status === 'paid' && order.ticket_id !== null && <p><Link className="button" to={`/tickets/${order.ticket_id}`}>{text.openTicket}</Link></p>}
    <p><Link to="/orders">{t.common.myOrders}</Link></p>
  </section>;
}

export function OrdersPage() {
  const t = useT();
  const text = t.orders;
  const { id } = useParams<{ id: string }>();
  const { user, request } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setOrders(null); setError(null);
    if (!user) return;
    if (id !== undefined && parseEventId(id) === null) {
      setError(new ApiError((m) => m.orders.errors.ORDER_NOT_FOUND, { kind: 'validation' }));
      return;
    }
    const controller = new AbortController();
    request(id ? `/orders/${id}` : '/orders/me', { signal: controller.signal })
      .then((value) => id ? [readOrder(value)] : readOrders(value))
      .then((value) => { if (!controller.signal.aborted) setOrders(value); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [id, user, request, attempt]);
  return <Page eyebrow={text.visitor} title={id ? text.orderTitle : t.common.myOrders} description={text.demoNotice}>
    {!user ? <Link to={authLink('/login', id ? `/orders/${id}` : '/orders')}>{t.common.login}</Link>
      : error != null ? <div role="alert"><p>{orderError(error)}</p><button onClick={() => setAttempt((n) => n + 1)}>{t.common.retry}</button></div>
        : orders === null ? <p role="status">{text.loading}</p>
          : id && orders[0] ? <OrderView key={`${user.id}:${orders[0].id}:${attempt}`} initial={orders[0]} />
            : orders.length ? <ul>{orders.map((order) => <li key={order.id}>
              <Link to={`/orders/${order.id}`}>{text.orderNumber(order.id)}</Link> · {text.status[order.status]} · {formatOrderAmount(order.total_tiyn)}
            </li>)}</ul> : <p>{text.empty}</p>}
  </Page>;
}
