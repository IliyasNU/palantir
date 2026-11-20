import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { parseEventId, readEventDetails } from '../events/details';
import { formatEventDate } from '../events/catalog';
import { useT } from '../i18n';
import { canManageEvents } from '../organizer/model';
import { formatOrderAmount, orderError, readBulkRefund, readManagedOrders } from '../orders/model';
import type { ManagedOrders } from '../orders/model';
import type { EventDetails } from '../events/details';
import { OrganizerGate } from './OrganizerPage';

type Result = 'cancelled' | 'refunded' | ReturnType<typeof readBulkRefund>;

export function ManageOrdersPage() {
  const t = useT();
  const { id } = useParams();
  const { user } = useAuth();
  const eventId = parseEventId(id);
  const allowed = canManageEvents(user);
  return <Page eyebrow={t.organizer.eyebrow} title={t.orders.manage.title} description={t.orders.manage.description}>
    <OrganizerGate allowed={allowed} returnTo={`/organizer/events/${id}/orders`} />
    {allowed && (eventId === null ? <p>{t.event.notFound}</p> : <ManageOrders key={`${user?.id}:${eventId}`} eventId={eventId} />)}
  </Page>;
}

function ManageOrders({ eventId }: { eventId: number }) {
  const { orders: text, common } = useT();
  const copy = text.manage;
  const { request } = useAuth();
  const { pending, error, submit } = useSubmission();
  const [data, setData] = useState<(ManagedOrders & { event: EventDetails }) | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [filter, setFilter] = useState('');
  const path = `/events/${eventId}`;

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    Promise.all([request(path, options), request(path + '/orders/manage', options)]).then(([event, orders]) => {
      if (!controller.signal.aborted) setData({ event: readEventDetails(event, eventId), ...readManagedOrders(orders, eventId) });
    }).catch((problem: unknown) => {
      if (!controller.signal.aborted) setFailure(problem);
    });
    return () => controller.abort();
  }, [eventId, request, path, attempt]);

  function reload() {
    setData(null);
    setFailure(null);
    setAttempt((value) => value + 1);
  }

  function act(endpoint: string, confirmation: string, outcome: 'cancelled' | 'refunded' | 'bulk') {
    if (pending || !window.confirm(confirmation)) return;
    setResult(null);
    void submit(async (signal) => {
      const response = await request(endpoint, { method: 'POST', signal });
      if (!signal.aborted) {
        setResult(outcome === 'bulk' ? readBulkRefund(response) : outcome);
        reload();
      }
    });
  }

  const visible = data?.orders.filter(order => !filter || order.status === filter) ?? [];
  return <>
    {failure != null && <div role="alert"><p>{orderError(failure)}</p>
      <button type="button" onClick={reload}>{common.retry}</button></div>}
    {error != null && <p className="notice notice-error" role="alert">{orderError(error)}</p>}
    {result && <p className="notice notice-success" role="status">
      {typeof result === 'string' ? copy[result] : copy.refundedAll(result.refunded_count, formatOrderAmount(result.refunds_tiyn))}
    </p>}
    {data === null && failure == null && <p role="status">{text.loading}</p>}
    {data && <>
      <h2>{data.event.title}</h2>
      <section className="content-card" aria-label={copy.paid} aria-busy={pending}>
        <h3>{copy.paid}</h3>
        {data.event.status === 'cancelled' && data.orders.some(order => order.status === 'paid') &&
          <button type="button" className="button" disabled={pending}
            onClick={() => act(path + '/orders/refund-all', copy.confirmAll, 'bulk')}>{copy.refundAll}</button>}
        <p><label>{copy.filter}{' '}
          <select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="">{copy.allStatuses}</option>
            {Object.entries(text.status).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
          </select>
        </label></p>
        {visible.length ? <ul>{visible.map(order => <li key={order.id}>
          <h4>{text.orderNumber(order.id)} · {text.status[order.status]}</h4>
          <p>{order.attendee_name} · {order.attendee_email} · {formatOrderAmount(order.total_tiyn)}</p>
          {order.refunded_at && <p>{text.refundedAmount(formatOrderAmount(order.total_tiyn), formatEventDate(order.refunded_at))}</p>}
          {order.status === 'paid' && <button type="button" className="button" disabled={pending}
            onClick={() => act(`${path}/orders/${order.id}/refund`, copy.confirmRefund(formatOrderAmount(order.total_tiyn)), 'refunded')}>
            {copy.refund}
          </button>}
        </li>)}</ul> : <p>{text.empty}</p>}
      </section>
      <section className="content-card" aria-label={copy.free} aria-busy={pending}>
        <h3>{copy.free}</h3>
        {data.free_registrations.length ? <ul>
          {data.free_registrations.map(ticket => <li key={ticket.id}>
            <h4>{copy.ticketNumber(ticket.id)} · {text.freeStatus[ticket.status]}</h4>
            <p>{ticket.attendee_name} · {ticket.attendee_email}</p>
            {ticket.status === 'active' && (ticket.checked_in_at ? <p>{copy.checkedIn}</p> :
              <button type="button" className="button" disabled={pending}
                onClick={() => act(`/tickets/${ticket.id}/cancel`, copy.confirmCancel, 'cancelled')}>{copy.cancelFree}</button>)}
          </li>)}
        </ul> : <p>{copy.noFree}</p>}
      </section>
    </>}
  </>;
}
