import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { parseEventId, readEventDetails } from '../events/details';
import type { EventDetails } from '../events/details';
import { emptyTicketTypeDraft, readTicketTypes, ticketTypeDraft, ticketTypeError, ticketTypePayload, ticketTypePrice } from '../ticket-types/model';
import type { TicketType, TicketTypeDraft } from '../ticket-types/model';

export function TicketTypesPage() {
  const { id } = useParams<{ id: string }>();
  const { user, request } = useAuth();
  const eventId = parseEventId(id);
  const returnTo = `/organizer/events/${id}/ticket-types`;
  return <Page eyebrow="Организатор · типы билетов" title="Типы билетов" description="Количество, сроки продаж и доступность каждого типа.">
    {eventId === null ? <p role="status">Событие не найдено.</p>
      : !user ? <p><Link className="button" to={authLink('/login', returnTo)}>Войти для управления типами</Link></p>
        : user.role !== 'organizer' && user.role !== 'admin' ? <p role="status">Управление доступно организатору события и администратору.</p>
          : <TypeManagement key={`${user.id}:${eventId}`} eventId={eventId} request={request} />}
  </Page>;
}

function TypeManagement({ eventId, request }: { eventId: number; request: typeof api.request }) {
  const [event, setEvent] = useState<EventDetails | null>(null);
  const [types, setTypes] = useState<TicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<TicketTypeDraft>(emptyTicketTypeDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    Promise.all([
      request(`/events/${eventId}`, { signal: controller.signal }).then((payload) => readEventDetails(payload, eventId)),
      request(`/events/${eventId}/ticket-types/manage`, { signal: controller.signal }).then((payload) => readTicketTypes(payload, eventId)),
    ]).then(([loadedEvent, loadedTypes]) => {
      if (!controller.signal.aborted) { setEvent(loadedEvent); setTypes(loadedTypes); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setLoadError(failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
        ? 'Событие не найдено или у вас нет права управлять его типами.' : ticketTypeError(failure));
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
        setNotice(editing === null ? 'Тип билета создан.' : 'Изменения типа сохранены.');
        clear();
        setRevision((previous) => previous + 1);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(ticketTypeError(failure));
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  if (loading) return <p role="status">Загружаем типы билетов…</p>;
  if (loadError) return <div className="notice notice-error" role="alert"><p>{loadError}</p>
    <button className="button" type="button" onClick={() => setRevision((previous) => previous + 1)}>Повторить</button></div>;
  if (!event) return null;
  const allocated = types.reduce((sum, type) => sum + type.quantity, 0);
  return <>
    <div className="content-card type-management-summary">
      <h2>{event.title}</h2>
      <p>Вместимость: {event.capacity ?? 'неизвестна'} · распределено по типам: {allocated}</p>
      <p>Первый бесплатный тип получает всю вместимость события. Чтобы добавить ещё один тип, сначала уменьшите количество первого. Выданные действующие билеты освобождать нельзя.</p>
      <p>Скрытый тип остаётся в списке и в выданных билетах, но недоступен новым посетителям. Количество скрытых типов тоже входит в общую вместимость.</p>
      <p><Link className="text-link" to={`/events/${eventId}`}>Открыть страницу события</Link></p>
    </div>
    {notice && <p className="notice notice-success" role="status">{notice}</p>}
    <section className="type-list" aria-label="Типы события">
      <h2>Типы события</h2>
      {types.length ? <div className="table-scroll"><table className="ticket-types-table">
        <thead><tr><th>Тип</th><th>Цена</th><th>Количество</th><th>Остаток</th><th>Доступность</th><th>Действие</th></tr></thead>
        <tbody>{types.map((type) => <tr key={type.id}>
          <td><strong>{type.name}</strong>{type.description && <p>{type.description}</p>}</td>
          <td>{ticketTypePrice(type.price_tiyn)}</td><td>{type.quantity} (выдано {type.tickets_issued})</td><td>{type.remaining}</td>
          <td>{type.hidden ? 'Скрыт' : 'Виден'}{type.price_tiyn > 0 && <p className="field-hint">Продажа пока недоступна</p>}</td>
          <td><button className="text-button" type="button" disabled={saving} onClick={() => edit(type)} aria-label={`Редактировать ${type.name}`}>Редактировать</button></td>
        </tr>)}</tbody>
      </table></div> : <p>Типов пока нет.</p>}
    </section>
    <section className="content-card type-editor" aria-label="Настройки типа билета">
      <h2>{editing === null ? 'Новый тип билета' : 'Изменение типа билета'}</h2>
      <form className="auth-form" onSubmit={(submission) => { void save(submission); }} aria-busy={saving}>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <fieldset disabled={saving}>
          <label htmlFor="type-name">Название типа</label>
          <input id="type-name" value={draft.name} onChange={(input) => field('name', input.target.value)} required />
          <label htmlFor="type-description">Описание типа</label>
          <textarea id="type-description" value={draft.description} onChange={(input) => field('description', input.target.value)} rows={3} maxLength={5000} />
          <label htmlFor="type-price">Цена в тиынах</label>
          <input id="type-price" type="number" min="0" step="1" value={draft.price_tiyn} onChange={(input) => field('price_tiyn', input.target.value)} required aria-describedby="type-price-hint" />
          <p className="field-hint" id="type-price-hint">100 тиынов = 1 ₸, 0 — бесплатно. Платный тип можно создать, но продать на этом этапе нельзя.</p>
          <label htmlFor="type-quantity">Количество билетов типа</label>
          <input id="type-quantity" type="number" min="0" step="1" value={draft.quantity} onChange={(input) => field('quantity', input.target.value)} required />
          <label htmlFor="type-sales-start">Начало продаж</label>
          <input id="type-sales-start" type="datetime-local" value={draft.sales_start} onChange={(input) => field('sales_start', input.target.value)} />
          <label htmlFor="type-sales-end">Конец продаж</label>
          <input id="type-sales-end" type="datetime-local" value={draft.sales_end} onChange={(input) => field('sales_end', input.target.value)} />
          <p className="field-hint">Необязательные даты. Ввод — в часовом поясе браузера; сервер хранит UTC.</p>
          <label htmlFor="type-order-limit">Лимит билетов на заказ</label>
          <input id="type-order-limit" type="number" min="1" step="1" value={draft.order_limit} onChange={(input) => field('order_limit', input.target.value)} required />
          <p className="field-hint">Лимит хранится для следующих этапов. Сейчас выдаётся один билет на посетителя на событие.</p>
          <label className="type-checkbox"><input type="checkbox" checked={draft.hidden} onChange={(input) => field('hidden', input.target.checked)} /> Скрыть тип от посетителей</label>
          <button className="button" type="submit">{saving ? 'Сохраняем…' : editing === null ? 'Создать тип' : 'Сохранить изменения'}</button>
          {editing !== null && <button className="text-button" type="button" onClick={clear}>Отменить редактирование</button>}
        </fieldset>
      </form>
    </section>
    <ActionLog eventId={eventId} request={request} revision={revision} />
  </>;
}

interface AuditEntry { id: number; occurred_at: string; actor_id: number; action: string; description: string }

function ActionLog({ eventId, request, revision }: { eventId: number; request: typeof api.request; revision: number }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    request<unknown>(`/events/${eventId}/action-log`, { signal: controller.signal }).then((payload) => {
      if (!Array.isArray(payload) || payload.some((entry) => !entry || typeof entry !== 'object'
        || !Number.isSafeInteger(entry.id) || entry.event_id !== eventId || !Number.isSafeInteger(entry.actor_id)
        || typeof entry.occurred_at !== 'string' || !Number.isFinite(Date.parse(entry.occurred_at))
        || typeof entry.action !== 'string' || typeof entry.description !== 'string')) {
        throw new ApiError('Сервер вернул некорректный журнал действий.', { kind: 'response' });
      }
      if (!controller.signal.aborted) setEntries(payload as AuditEntry[]);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(ticketTypeError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventId, request, revision]);
  return <section className="content-card type-audit" aria-label="Журнал изменений типов">
    <h2>Журнал изменений типов</h2>
    <p>Записи только для чтения. Создание и изменение типов фиксируются сервером.</p>
    {loading ? <p>Загружаем журнал…</p> : error ? <p role="alert">{error}</p>
      : entries.length ? <ol>{entries.map((entry) => <li key={entry.id}>
        <time dateTime={entry.occurred_at}>{formatEventDate(entry.occurred_at)}</time> · пользователь #{entry.actor_id} · {entry.action}<p>{entry.description}</p>
      </li>)}</ol> : <p>Изменений типов пока нет.</p>}
  </section>;
}
