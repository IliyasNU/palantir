import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { parseEventId } from '../events/details';
import { orderError } from '../orders/model';
import { readTicketTypes, ticketTypePrice, type TicketType } from '../ticket-types/model';
import { readCampaigns, type Campaign } from '../campaigns/model';

export function CampaignsPage() {
  const {id} = useParams();
  const {user} = useAuth();
  const eventId = parseEventId(id);
  return <Page eyebrow="Организатор" title="Промокампании" description="Скидки на платные билеты и продажи по каждой акции.">
    {!eventId ? <p>Событие не найдено.</p> : !user ? <Link to={authLink('/login', `/organizer/events/${id}/campaigns`)}>Войти</Link>
      : !['organizer', 'admin'].includes(user.role) ? <p>Управление доступно организатору и администратору.</p>
      : <Manager key={user.id + ':' + id} id={eventId}/>}
  </Page>;
}

function Manager({id}: {id: number}) {
  const {request} = useAuth();
  const [items, setItems] = useState<Campaign[] | null>(null);
  const [types, setTypes] = useState<TicketType[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [kind, setKind] = useState('percent');
  const base = `/events/${id}/campaigns`;
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([request(base, {signal: controller.signal}).then(v => readCampaigns(v, id)),
      request(`/events/${id}/ticket-types/manage`, {signal: controller.signal}).then(v => readTicketTypes(v, id))])
      .then(([campaigns, allTypes]) => { if (!controller.signal.aborted) { setItems(campaigns); setTypes(allTypes); } })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(orderError(e)); });
    return () => controller.abort();
  }, [base, id, request, revision]);

  async function action(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await run(); } catch (e) { setError(orderError(e)); }
    finally { setBusy(false); }
  }
  async function create(form: HTMLFormElement) {
    const data = new FormData(form);
    const timestamp = (field: string) => data.get(field) ? new Date(String(data.get(field))).toISOString() : null;
    await request(base, {method: 'POST', body: {name: data.get('name'), kind, value: Number(data.get('value')),
      max_uses: Number(data.get('limit')), starts_at: timestamp('start'), ends_at: timestamp('end'),
      ticket_type_ids: data.getAll('types').map(Number)}});
    form.reset(); setKind('percent'); setRevision(v => v+1);
  }
  async function download(item: Campaign) {
    const blob = await request<Blob>(base + '/' + item.id + '/qr.svg', {blob: true});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'campaign-' + item.id + '.svg'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <>
    {error && <p role="alert">{error} <button type="button" onClick={() => {setError(''); setRevision(v => v+1);}}>Обновить данные</button></p>}
    {items === null ? !error && <p role="status">Загружаем кампании…</p> : <>
      <form className="auth-form content-card" onSubmit={e => {e.preventDefault(); const form = e.currentTarget; void action(() => create(form));}}>
        <h2>Новая кампания</h2>
        <label>Название<input name="name" required maxLength={120}/></label>
        <label>Вид скидки<select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="percent">Процент</option><option value="fixed">Фиксированная сумма</option>
        </select></label>
        <label>{kind === 'percent' ? 'Скидка, %' : 'Скидка, тиыны'}<input name="value" type="number" min={1}
          max={kind === 'percent' ? 100 : 2147483647} step={1} required/></label>
        <label>Лимит использований<input name="limit" type="number" min={1} max={2147483647} step={1} required/></label>
        <label>Начало акции<input name="start" type="datetime-local"/></label>
        <label>Окончание акции<input name="end" type="datetime-local"/></label>
        <fieldset><legend>Типы билетов</legend><p>Без выбора скидка действует на все платные типы.</p>
          {types.filter(t => t.price_tiyn > 0).map(t => <label key={t.id}><input type="checkbox" name="types" value={t.id}/>{t.name}</label>)}
        </fieldset>
        <button className="button" disabled={busy}>Создать кампанию</button>
      </form>
      <h2>Кампании события</h2>
      {!items.length && <p>Кампаний пока нет.</p>}
      {items.map(item => <section key={item.id} className="content-card">
        <h3>{item.name}</h3><p>Промокод <strong>{item.code}</strong> · {item.enabled ? 'Включена' : 'Выключена'}</p>
        <p><a href={item.link}>Открыть страницу акции</a></p>
        <button disabled={busy} onClick={() => void action(() => download(item))}>Скачать QR акции · Это не билет</button>{' '}
        <button disabled={busy} onClick={() => void action(async () => {
          await request(base + '/' + item.id, {method: 'PATCH', body: {enabled: !item.enabled}}); setRevision(v => v+1);
        })}>{item.enabled ? 'Выключить кампанию' : 'Включить кампанию'}</button>
        <dl><dt>Использования / лимит</dt><dd>{item.redemptions} / {item.max_uses}</dd>
          <dt>Все заказы / проданные билеты</dt><dd>{item.orders} / {item.tickets_sold}</dd>
          <dt>Продажи до скидки</dt><dd>{ticketTypePrice(item.gross_tiyn)}</dd>
          <dt>Скидки</dt><dd>{ticketTypePrice(item.discount_tiyn)}</dd>
          <dt>После скидок</dt><dd>{ticketTypePrice(item.net_sales_tiyn)}</dd>
          <dt>Выручка после комиссии</dt><dd>{ticketTypePrice(item.organizer_net_tiyn)}</dd></dl>
      </section>)}
    </>}
  </>;
}
