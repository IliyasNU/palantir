import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { DEMO_NOTICE, orderError, readOrder, readOrders, statusLabels } from '../orders/model';
import type { Order } from '../orders/model';
import { ticketTypePrice } from '../ticket-types/model';
import { parseEventId } from '../events/details';

export function OrderView({ initial }: { initial: Order }) {
  const { request } = useAuth();
  const [order, setOrder] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  async function act(action: 'success' | 'failure' | 'cancel') {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(null);
    try {
      const next = readOrder(await request(`/orders/${order.id}/${action === 'cancel' ? 'cancel' : 'pay'}`, {
        method: 'POST', ...(action === 'cancel' ? {} : { body: { outcome: action } }),
      }));
      if (next.id !== order.id) throw new Error('Unexpected order');
      setOrder(next);
    } catch (failure) {
      setError(orderError(failure));
      // Lost confirmations are recovered from the same order, never a new purchase.
      try { setOrder(readOrder(await request(`/orders/${order.id}`))); } catch { /* retain retry controls */ }
    } finally { guard.current = false; setBusy(false); }
  }
  return <section className="content-card" aria-label="Демо-заказ" aria-busy={busy}>
    <p className="notice">{DEMO_NOTICE}</p>
    <h2>Заказ №{order.id} · {statusLabels[order.status]}</h2>
    <p>{order.attendee_name} · {order.attendee_email}</p>
    <p>Цена билета: {ticketTypePrice(order.subtotal_tiyn)}</p>
    <p>Комиссия из выручки организатора: {ticketTypePrice(order.processing_fee_tiyn)}</p>
    <p><strong>Итого покупателю: {ticketTypePrice(order.total_tiyn)}</strong></p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {order.status === 'pending' && <>
      <p>Резерв до {new Date(order.expires_at).toLocaleString('ru-RU')}. Срок проверяет сервер.</p>
      <button className="button" disabled={busy} onClick={() => { void act('success'); }}>Имитировать успешную оплату</button>{' '}
      <button className="text-button" disabled={busy} onClick={() => { void act('failure'); }}>Имитировать отказ оплаты</button>{' '}
      <button className="text-button" disabled={busy} onClick={() => { void act('cancel'); }}>Отменить заказ</button>
    </>}
    {order.ticket_id !== null && <p><Link className="button" to={`/tickets/${order.ticket_id}`}>Открыть билет</Link></p>}
    <p><Link to="/orders">Мои заказы</Link></p>
  </section>;
}

export function OrdersPage() {
  const { id } = useParams<{ id: string }>();
  const { user, request } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setOrders(null); setError(null);
    if (!user) return;
    if (id !== undefined && parseEventId(id) === null) { setError('Заказ не найден.'); return; }
    const controller = new AbortController();
    request(id ? `/orders/${id}` : '/orders/me', { signal: controller.signal })
      .then((value) => id ? [readOrder(value)] : readOrders(value))
      .then((value) => { if (!controller.signal.aborted) setOrders(value); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(orderError(failure)); });
    return () => controller.abort();
  }, [id, user, request, attempt]);
  return <Page eyebrow="Посетитель" title={id ? 'Демо-заказ' : 'Мои заказы'} description={DEMO_NOTICE}>
    {!user ? <Link to={`/login?returnTo=${encodeURIComponent(id ? `/orders/${id}` : '/orders')}`}>Войти</Link>
      : error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt((n) => n + 1)}>Повторить</button></div>
        : orders === null ? <p role="status">Загружаем заказы…</p>
          : id && orders[0] ? <OrderView key={`${user.id}:${orders[0].id}:${attempt}`} initial={orders[0]} />
            : orders.length ? <ul>{orders.map((order) => <li key={order.id}>
              <Link to={`/orders/${order.id}`}>Заказ №{order.id}</Link> · {statusLabels[order.status]} · {ticketTypePrice(order.total_tiyn)}
            </li>)}</ul> : <p>Заказов пока нет.</p>}
  </Page>;
}
