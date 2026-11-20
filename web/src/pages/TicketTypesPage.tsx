import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { parseEventId } from '../events/details';
import { useT } from '../i18n';
import { eventPhase, isClosedPhase, readManagedEvent } from '../organizer/model';
import type { ManagedEvent } from '../organizer/model';
import { emptyTicketTypeDraft, readTicketTypes, ticketTypeDraft, ticketTypeError, ticketTypePayload, ticketTypePrice } from '../ticket-types/model';
import type { TicketType, TicketTypeDraft } from '../ticket-types/model';

export function TicketTypesPage() {
  const t = useT().ticketTypeManagement;
  const { id } = useParams<{ id: string }>();
  const { user, request } = useAuth();
  const eventId = parseEventId(id);
  const returnTo = `/organizer/events/${id}/ticket-types`;
  return <Page eyebrow={t.eyebrow} title={t.title} description={t.description}>
    {eventId === null ? <p role="status">{t.eventNotFound}</p>
      : !user ? <p><Link className="button" to={authLink('/login', returnTo)}>{t.signIn}</Link></p>
        : user.role !== 'organizer' && user.role !== 'admin' ? <p role="status">{t.access}</p>
          : <TypeManagement key={`${user.id}:${eventId}`} eventId={eventId} request={request} />}
  </Page>;
}

function TypeManagement({ eventId, request }: { eventId: number; request: typeof api.request }) {
  const t = useT().ticketTypeManagement;
  const [event, setEvent] = useState<ManagedEvent | null>(null);
  const [types, setTypes] = useState<TicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ failure: unknown } | null>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<TicketTypeDraft>(emptyTicketTypeDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ failure: unknown } | null>(null);
  const [notice, setNotice] = useState<'created' | 'saved' | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    Promise.all([
      request(`/events/${eventId}`, { signal: controller.signal }).then((payload) => readManagedEvent(payload, eventId)),
      request(`/events/${eventId}/ticket-types/manage`, { signal: controller.signal }).then((payload) => readTicketTypes(payload, eventId)),
    ]).then(([loadedEvent, loadedTypes]) => {
      if (!controller.signal.aborted) { setEvent(loadedEvent); setTypes(loadedTypes); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setLoadError({ failure });
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventId, request, revision]);
  useEffect(() => () => { inFlight.current?.abort(); }, []);

  function edit(type: TicketType) {
    setEditing(type.id);
    setDraft(ticketTypeDraft(type));
    setError(null);
    setNotice(null);
  }
  function clear() {
    setEditing(null);
    setDraft(emptyTicketTypeDraft());
    setError(null);
  }
  function field<K extends keyof TicketTypeDraft>(name: K, value: TicketTypeDraft[K]) {
    setDraft((previous) => ({ ...previous, [name]: value }));
  }
  async function save(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = ticketTypePayload(draft, types.find((type) => type.id === editing));
      await request(`/events/${eventId}/ticket-types${editing === null ? '' : `/${editing}`}`, {
        method: editing === null ? 'POST' : 'PATCH', body: payload, signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setNotice(editing === null ? 'created' : 'saved');
        clear();
        setRevision((previous) => previous + 1);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError({ failure });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  if (loading) return <p role="status">{t.loading}</p>;
  if (loadError) {
    const { failure } = loadError;
    const unavailable = failure instanceof ApiError && (failure.status === 403 || failure.status === 404);
    return <div className="notice notice-error" role="alert"><p>{unavailable ? t.eventUnavailable : ticketTypeError(failure)}</p>
      <button className="button" type="button" onClick={() => setRevision((previous) => previous + 1)}>{t.retry}</button></div>;
  }
  if (!event) return null;
  if (isClosedPhase(eventPhase(event))) return <Navigate replace to={`/organizer/events/${eventId}/history`} />;
  const allocated = types.reduce((sum, type) => sum + type.quantity, 0);
  return <>
    <div className="content-card type-management-summary">
      <h2>{event.title}</h2>
      <p><Link to={`/organizer/events/${eventId}/activation`}>{t.activation}</Link></p>
      <p><Link to={`/organizer/events/${eventId}/campaigns`}>{t.campaigns}</Link></p>
      <p>{t.capacity(event.capacity, allocated)}</p>
      <p>{t.quotaHint}</p>
      <p>{t.hiddenHint}</p>
      <p><Link className="text-link" to={`/events/${eventId}`}>{t.openEvent}</Link></p>
    </div>
    {notice && <p className="notice notice-success" role="status">{t[notice]}</p>}
    <section className="type-list" aria-label={t.typeList}>
      <h2>{t.typeList}</h2>
      {types.length ? <div className="table-scroll"><table className="ticket-types-table">
        <thead><tr><th>{t.columns.type}</th><th>{t.columns.price}</th><th>{t.columns.quantity}</th>
          <th>{t.columns.remaining}</th><th>{t.columns.visibility}</th><th>{t.columns.action}</th></tr></thead>
        <tbody>{types.map((type) => <tr key={type.id}>
          <td><strong>{type.name}</strong>{type.description && <p>{type.description}</p>}</td>
          <td>{ticketTypePrice(type.price_tiyn)}</td><td>{t.issued(type.quantity, type.tickets_issued)}</td><td>{type.remaining}</td>
          <td>{type.hidden ? t.hidden : t.visible}{type.price_tiyn > 0 && <p className="field-hint">{t.paidHint}</p>}</td>
          <td><button className="text-button" type="button" disabled={saving} onClick={() => edit(type)} aria-label={t.editNamed(type.name)}>{t.edit}</button></td>
        </tr>)}</tbody>
      </table></div> : <p>{t.empty}</p>}
    </section>
    <section className="content-card type-editor" aria-label={t.settings}>
      <h2>{editing === null ? t.newType : t.editType}</h2>
      <form className="auth-form" onSubmit={(submission) => { void save(submission); }} aria-busy={saving}>
        {error && <p className="notice notice-error" role="alert">{ticketTypeError(error.failure)}</p>}
        <fieldset disabled={saving}>
          <label htmlFor="type-name">{t.name}</label>
          <input id="type-name" value={draft.name} onChange={(input) => field('name', input.target.value)} required />
          <label htmlFor="type-description">{t.typeDescription}</label>
          <textarea id="type-description" value={draft.description} onChange={(input) => field('description', input.target.value)} rows={3} maxLength={5000} />
          <label htmlFor="type-price">{t.price}</label>
          <input id="type-price" type="number" min="0" step="1" value={draft.price_tiyn} onChange={(input) => field('price_tiyn', input.target.value)} required aria-describedby="type-price-hint" />
          <p className="field-hint" id="type-price-hint">{t.priceHint}</p>
          <label htmlFor="type-quantity">{t.quantity}</label>
          <input id="type-quantity" type="number" min="0" step="1" value={draft.quantity} onChange={(input) => field('quantity', input.target.value)} required />
          <label htmlFor="type-sales-start">{t.salesStart}</label>
          <input id="type-sales-start" type="datetime-local" value={draft.sales_start} onChange={(input) => field('sales_start', input.target.value)} />
          <label htmlFor="type-sales-end">{t.salesEnd}</label>
          <input id="type-sales-end" type="datetime-local" value={draft.sales_end} onChange={(input) => field('sales_end', input.target.value)} />
          <p className="field-hint">{t.windowHint}</p>
          <label htmlFor="type-order-limit">{t.orderLimit}</label>
          <input id="type-order-limit" type="number" min="1" step="1" value={draft.order_limit} onChange={(input) => field('order_limit', input.target.value)} required />
          <p className="field-hint">{t.orderLimitHint}</p>
          <label className="type-checkbox"><input type="checkbox" checked={draft.hidden} onChange={(input) => field('hidden', input.target.checked)} /> {t.hide}</label>
          <button className="button" type="submit">{saving ? t.saving : editing === null ? t.create : t.save}</button>
          {editing !== null && <button className="text-button" type="button" onClick={clear}>{t.cancel}</button>}
        </fieldset>
      </form>
    </section>
    <ActionLog eventId={eventId} request={request} revision={revision} />
  </>;
}

interface AuditEntry { id: number; occurred_at: string; actor_id: number; action: string; description: string }

function ActionLog({ eventId, request, revision }: { eventId: number; request: typeof api.request; revision: number }) {
  const t = useT().ticketTypeManagement;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<{ failure: unknown } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // The event timeline also holds check-ins, staff and lifecycle actions; this section lists type changes only.
    request<unknown>(`/events/${eventId}/action-log?action=ticket_type`, { signal: controller.signal }).then((payload) => {
      if (!Array.isArray(payload) || payload.some((entry) => !entry || typeof entry !== 'object'
        || !Number.isSafeInteger(entry.id) || entry.event_id !== eventId || !Number.isSafeInteger(entry.actor_id)
        || typeof entry.occurred_at !== 'string' || !Number.isFinite(Date.parse(entry.occurred_at))
        || typeof entry.action !== 'string' || typeof entry.description !== 'string')) {
        throw new ApiError((messages) => messages.ticketTypeManagement.auditMalformed, { kind: 'response' });
      }
      if (!controller.signal.aborted) setEntries(payload as AuditEntry[]);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError({ failure }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventId, request, revision]);
  return <section className="content-card type-audit" aria-label={t.auditTitle}>
    <h2>{t.auditTitle}</h2>
    <p>{t.auditHint}</p>
    {loading ? <p>{t.auditLoading}</p> : error ? <p role="alert">{ticketTypeError(error.failure)}</p>
      : entries.length ? <ol>{entries.map((entry) => <li key={entry.id}>
        <time dateTime={entry.occurred_at}>{formatEventDate(entry.occurred_at)}</time> · {t.auditActor(entry.actor_id)} · {entry.action}<p>{entry.description}</p>
      </li>)}</ol> : <p>{t.auditEmpty}</p>}
  </section>;
}
