import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { parseEventId } from '../events/details';
import { DEMO_NOTICE, orderError, readActivation } from '../orders/model';
import type { Activation } from '../orders/model';
import { ticketTypePrice } from '../ticket-types/model';
import { ApiError } from '../api';

const labels = { paid_type: 'Создан платный тип билета', identity: 'Личность подтверждена (демо)',
  payout: 'Реквизиты подтверждены (демо)', terms: 'Условия платных продаж приняты', fee: 'Сбор активации оплачен (демо)' };

type Summary = Record<'gross_sales_tiyn' | 'processing_fees_tiyn' | 'refunds_tiyn' | 'estimated_payout_tiyn', number>;
function readSummary(value: unknown): Summary {
  if (!value || typeof value !== 'object' || !('simulation' in value) || value.simulation !== true) throw new ApiError('Некорректная сводка.', { kind: 'response' });
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of ['gross_sales_tiyn', 'processing_fees_tiyn', 'refunds_tiyn', 'estimated_payout_tiyn']) {
    if (typeof source[key] !== 'number' || !Number.isSafeInteger(source[key]) || source[key] < 0) throw new ApiError('Некорректная сумма.', { kind: 'response' });
    result[key] = source[key];
  }
  return result as Summary;
}

export function ActivationPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const eventId = parseEventId(id);
  return <Page eyebrow="Организатор" title="Активация платных продаж" description={DEMO_NOTICE}>
    {!user ? <Link to={`/login?returnTo=${encodeURIComponent(`/organizer/events/${id}/activation`)}`}>Войти</Link>
      : eventId === null ? <p>Событие не найдено.</p>
        : <ActivationForm key={`${user.id}:${eventId}`} eventId={eventId} />}
  </Page>;
}

function ActivationForm({ eventId }: { eventId: number }) {
  const { user, request } = useAuth();
  const [state, setState] = useState<Activation | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [suffix, setSuffix] = useState('');
  const [organization, setOrganization] = useState('');
  const [reason, setReason] = useState('');
  const guard = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request(`/events/${eventId}/activation`, { signal: controller.signal }).then(readActivation),
      request(`/events/${eventId}/orders/summary`, { signal: controller.signal }).then(readSummary),
    ]).then(([activation, sales]) => { if (!controller.signal.aborted) { setState(activation); setSummary(sales); } })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(orderError(failure)); });
    return () => controller.abort();
  }, [eventId, request, revision]);
  async function act(path: string, body?: unknown) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(null);
    try {
      await request(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
      setRevision((value) => value + 1);
    } catch (failure) { setError(orderError(failure)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    {error && <div role="alert"><p>{error}</p><button onClick={() => { setError(null); setRevision((n) => n + 1); }}>Обновить</button></div>}
    {!state && !error && <p role="status">Загружаем чек-лист…</p>}
    {state && <section className="content-card" aria-busy={busy}>
      <h2>{state.activated ? 'Активация завершена' : 'Чек-лист активации'}</h2>
      <ul>{(Object.keys(labels) as (keyof typeof labels)[]).map((key) => <li key={key}>{state.steps[key].done ? '✓' : '○'} {labels[key]}</li>)}</ul>
      {state.paid_sales_suspended && <p role="status">Платные продажи приостановлены администратором.</p>}
      <p><Link to={`/organizer/events/${eventId}/ticket-types`}>Настроить типы билетов</Link></p>
      <fieldset disabled={busy}>
        {user?.role === 'organizer' && <>
          <details><summary>Профиль ещё не создан</summary>
            <label htmlFor="organization-name">Название организации</label>
            <input id="organization-name" value={organization} onChange={(e) => setOrganization(e.target.value)} maxLength={200} />
            <button className="text-button" disabled={organization.trim().length < 2} onClick={() => { void act('/organizer-profiles', { organization_name: organization.trim() }); }}>Создать профиль</button>
          </details>
          <button className="button" disabled={state.steps.identity.done} onClick={() => { void act('/organizer-profiles/me/confirm-identity'); }}>Подтвердить личность (демо)</button>
          <label htmlFor="payout-suffix">Последние 4 символа демо-реквизита</label>
          <input id="payout-suffix" value={suffix} maxLength={4} onChange={(e) => setSuffix(e.target.value)} aria-describedby="payout-hint" />
          <p id="payout-hint">Например, D123. Настоящие номера карт, счетов и ИИН не вводи.</p>
          <button className="button" disabled={!/^[A-Za-z0-9]{4}$/.test(suffix)} onClick={() => { void act('/organizer-profiles/me/payout-details', { reference_last4: suffix }); }}>Сохранить демо-реквизит</button>
        </>}
        <p>Условия демо: реальных платежей и выплат нет. Комиссия 3% удерживается из выручки организатора. Покупатель платит только цену билета.</p>
        <button className="button" disabled={state.steps.terms.done} onClick={() => { void act(`/events/${eventId}/activation/terms`); }}>Принять условия</button>{' '}
        <button className="button" disabled={state.steps.fee.done} onClick={() => { void act(`/events/${eventId}/activation/fee`); }}>Имитировать оплату сбора {ticketTypePrice(state.activation_fee_tiyn)}</button>
        {user?.role === 'admin' && <div>
          <label htmlFor="paid-suspension-reason">Причина приостановки</label>
          <input id="paid-suspension-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          <button disabled={reason.trim().length < 3} onClick={() => { void act(`/admin/events/${eventId}/paid-sales/suspend`, { reason }); }}>Приостановить платные продажи</button>
          <button onClick={() => { void act(`/admin/events/${eventId}/paid-sales/restore`); }}>Возобновить платные продажи</button>
        </div>}
      </fieldset>
    </section>}
    {summary && <section className="content-card"><h2>Сводка демо-продаж</h2>
      <p>Продажи: {ticketTypePrice(summary.gross_sales_tiyn)}</p><p>Комиссия: {ticketTypePrice(summary.processing_fees_tiyn)}</p>
      <p>Возвраты: {ticketTypePrice(summary.refunds_tiyn)} — появятся в P5</p><p>Оценка выплаты: {ticketTypePrice(summary.estimated_payout_tiyn)}</p>
    </section>}
  </>;
}
