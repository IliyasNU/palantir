import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { parseEventId } from '../events/details';
import { formatOrderAmount, orderError, readActivation } from '../orders/model';
import type { Activation } from '../orders/model';
import { ApiError } from '../api';
import { useT } from '../i18n';

const steps = ['paid_type', 'identity', 'payout', 'terms', 'fee'] as const;

type Summary = Record<'gross_sales_tiyn' | 'processing_fees_tiyn' | 'refunds_tiyn' | 'estimated_payout_tiyn', number>;
function readSummary(value: unknown): Summary {
  if (!value || typeof value !== 'object' || !('simulation' in value) || value.simulation !== true) throw new ApiError((t) => t.orders.activation.invalidSummary, { kind: 'response' });
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of ['gross_sales_tiyn', 'processing_fees_tiyn', 'refunds_tiyn', 'estimated_payout_tiyn']) {
    if (typeof source[key] !== 'number' || !Number.isSafeInteger(source[key]) || source[key] < 0) throw new ApiError((t) => t.orders.activation.invalidAmount, { kind: 'response' });
    result[key] = source[key];
  }
  return result as Summary;
}

export function ActivationPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const eventId = parseEventId(id);
  return <Page eyebrow={t.organizer.eyebrow} title={t.orders.activation.title} description={t.orders.demoNotice}>
    {!user ? <Link to={`/login?returnTo=${encodeURIComponent(`/organizer/events/${id}/activation`)}`}>{t.common.login}</Link>
      : eventId === null ? <p>{t.event.notFound}</p>
        : <ActivationForm key={`${user.id}:${eventId}`} eventId={eventId} />}
  </Page>;
}

function ActivationForm({ eventId }: { eventId: number }) {
  const { orders, common } = useT();
  const { activation: text, sales } = orders;
  const { user, request } = useAuth();
  const [state, setState] = useState<Activation | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
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
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [eventId, request, revision]);
  async function act(path: string, body?: unknown) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(null);
    try {
      await request(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
      setRevision((value) => value + 1);
    } catch (failure) { setError(failure); }
    finally { guard.current = false; setBusy(false); }
  }
  return <>
    {error != null && <div role="alert"><p>{orderError(error)}</p><button onClick={() => { setError(null); setRevision((n) => n + 1); }}>{common.retry}</button></div>}
    {!state && error == null && <p role="status">{text.loading}</p>}
    {state && <section className="content-card" aria-busy={busy}>
      <h2>{state.activated ? text.activated : text.checklist}</h2>
      <ul>{steps.map((key) => <li key={key}>{state.steps[key].done ? '✓' : '○'} {text.steps[key]}</li>)}</ul>
      {state.paid_sales_suspended && <p role="status">{text.suspended}</p>}
      <p><Link to={`/organizer/events/${eventId}/ticket-types`}>{text.types}</Link></p>
      <fieldset disabled={busy}>
        {user?.role === 'organizer' && <>
          <details><summary>{text.profileMissing}</summary>
            <label htmlFor="organization-name">{text.organization}</label>
            <input id="organization-name" value={organization} onChange={(e) => setOrganization(e.target.value)} maxLength={200} />
            <button className="text-button" disabled={organization.trim().length < 2} onClick={() => { void act('/organizer-profiles', { organization_name: organization.trim() }); }}>{text.createProfile}</button>
          </details>
          <button className="button" disabled={state.steps.identity.done} onClick={() => { void act('/organizer-profiles/me/confirm-identity'); }}>{text.identity}</button>
          <label htmlFor="payout-suffix">{text.payout}</label>
          <input id="payout-suffix" value={suffix} maxLength={4} onChange={(e) => setSuffix(e.target.value)} aria-describedby="payout-hint" />
          <p id="payout-hint">{text.payoutHint}</p>
          <button className="button" disabled={!/^[A-Za-z0-9]{4}$/.test(suffix)} onClick={() => { void act('/organizer-profiles/me/payout-details', { reference_last4: suffix }); }}>{text.savePayout}</button>
        </>}
        <p>{text.demoTerms}</p>
        <button className="button" disabled={state.steps.terms.done} onClick={() => { void act(`/events/${eventId}/activation/terms`); }}>{text.terms}</button>{' '}
        <button className="button" disabled={state.steps.fee.done} onClick={() => { void act(`/events/${eventId}/activation/fee`); }}>{text.fee} {formatOrderAmount(state.activation_fee_tiyn)}</button>
        {user?.role === 'admin' && <div>
          <label htmlFor="paid-suspension-reason">{text.reason}</label>
          <input id="paid-suspension-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          <button disabled={reason.trim().length < 3} onClick={() => { void act(`/admin/events/${eventId}/paid-sales/suspend`, { reason }); }}>{text.suspend}</button>
          <button onClick={() => { void act(`/admin/events/${eventId}/paid-sales/restore`); }}>{text.restore}</button>
        </div>}
      </fieldset>
    </section>}
    {summary && <section className="content-card"><h2>{sales.title}</h2>
      <p>{sales.gross(formatOrderAmount(summary.gross_sales_tiyn))}</p>
      <p>{sales.fees(formatOrderAmount(summary.processing_fees_tiyn))}</p>
      <p>{sales.refunds(formatOrderAmount(summary.refunds_tiyn))}</p>
      <p>{sales.payout(formatOrderAmount(summary.estimated_payout_tiyn))}</p>
    </section>}
  </>;
}
