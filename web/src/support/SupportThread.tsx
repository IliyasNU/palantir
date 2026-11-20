import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { isAdmin } from '../admin/model';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { useT } from '../i18n';
import { formatDateTime, formatNumber } from '../i18n/format';
import { ticketTypePrice } from '../ticket-types/model';
import { caseStatuses, isOneOf, messageBody, messageLimit, parseSupportId, readCase, readMessages, supportError } from './model';
import type { CaseStatus, CaseUpdate, SupportCase } from './model';
import { SupportSignIn } from './SupportHome';

export function SupportThread() {
  const t = useT().support;
  const { user } = useAuth();
  const { id } = useParams();
  const caseId = parseSupportId(id);
  return <Page eyebrow={t.menu} title={t.thread} description={t.threadDescription}>
    {!user ? <SupportSignIn />
      : caseId === null ? <p className="notice notice-error" role="alert">{t.errors.CASE_NOT_FOUND}</p>
      : <CaseDetails key={`${user.id}:${caseId}`} caseId={caseId} userId={user.id} admin={isAdmin(user)} />}
    <p><Link className="text-link" to="/support">{t.mine}</Link></p>
  </Page>;
}

type DetailState = { loading: true } | { loading: false; detail: SupportCase } | { loading: false; error: unknown };

function CaseDetails({ caseId, userId, admin }: { caseId: number; userId: number; admin: boolean }) {
  const t = useT().support;
  const { request } = useAuth();
  const submission = useSubmission();
  const [state, setState] = useState<DetailState>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState('');
  const [moreMessages, setMoreMessages] = useState(false);
  const path = `/support/cases/${caseId}`;

  useEffect(() => {
    const controller = new AbortController();
    void request(path, { signal: controller.signal }).then(payload => readCase(payload, caseId)).then(detail => {
      if (controller.signal.aborted) return;
      setState({ loading: false, detail });
      setMoreMessages(detail.messages.length === messageLimit);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ loading: false, error });
    });
    return () => controller.abort();
  }, [request, path, caseId, attempt]);

  function refresh() {
    setState({ loading: true });
    setAttempt(value => value + 1);
  }

  if (state.loading) return <p role="status">{t.loading}</p>;
  if ('error' in state) return <div className="notice notice-error" role="alert">
    <p>{supportError(state.error, t)}</p>
    <button className="text-button" type="button" onClick={refresh}>{t.retry}</button>
  </div>;
  const { detail } = state;

  function update(build: () => CaseUpdate) {
    void submission.submit(async signal => {
      await request(path, { method: 'PATCH', body: build(), signal });
      if (!signal.aborted) refresh();
    });
  }

  function loadMore() {
    void submission.submit(async signal => {
      const cursor = detail.messages.at(-1)?.id;
      if (cursor === undefined) return;
      const payload = await request(`${path}/messages?after_id=${cursor}`, { signal });
      const next = readMessages(payload, caseId, cursor);
      if (signal.aborted) return;
      setState({ loading: false, detail: { ...detail, messages: [...detail.messages, ...next] } });
      setMoreMessages(next.length === messageLimit);
    });
  }

  return <article className="content-card support-panel" aria-busy={submission.pending}>
    <h2>{detail.subject}</h2>
    <p>{t.kinds[detail.kind]} · {t.categories[detail.category]}</p>
    <CaseFacts detail={detail} />
    <div className="organizer-links">
      <button className="button button-secondary" type="button" onClick={refresh} disabled={submission.pending}>{t.refresh}</button>
      {admin && <Link className="text-link" to="/admin/support">{t.adminQueue}</Link>}
      {!admin && detail.kind === 'attendee' && detail.can_manage && detail.context.event &&
        <Link className="text-link" to={`/organizer/events/${detail.context.event.id}/support`}>{t.eventQueue}</Link>}
    </div>
    {detail.can_manage ? <HandlerControls key={detail.status} detail={detail} userId={userId} pending={submission.pending} update={update} />
      : detail.viewer_side === 'requester' && detail.status !== 'resolved' &&
        <button className="button button-secondary" type="button" disabled={submission.pending}
          onClick={() => update(() => ({ status: 'resolved' }))}>{t.resolve}</button>}
    <h3>{t.conversation}</h3>
    <ol className="support-messages">
      {detail.messages.map(item => <li key={item.id}>
        <p><strong>{item.author_name}</strong> · {t.sides[item.author_side]} ·{' '}
          <time dateTime={item.created_at}>{formatDateTime(item.created_at, 'medium')}</time>
        </p>
        <p className="support-message-body">{item.body}</p>
      </li>)}
    </ol>
    {moreMessages && <button className="button button-secondary" type="button"
      disabled={submission.pending} onClick={loadMore}>{t.moreMessages}</button>}
    {submission.error !== null && <p className="notice notice-error" role="alert">{supportError(submission.error, t)}</p>}
    <form className="support-form" noValidate onSubmit={event => {
      event.preventDefault();
      void submission.submit(async signal => {
        await request(`${path}/messages`, { method: 'POST', body: { body: messageBody(message) }, signal });
        if (!signal.aborted) {
          setMessage('');
          refresh();
        }
      });
    }}>
      <label>{t.reply}<textarea required rows={4} value={message} disabled={submission.pending}
        onChange={event => setMessage(event.currentTarget.value)} /></label>
      <button className="button" type="submit" disabled={submission.pending}>{t.send}</button>
    </form>
  </article>;
}

function CaseFacts({ detail }: { detail: SupportCase }) {
  const t = useT().support;
  const { event, order, ticket } = detail.context;
  const requester = detail.viewer_side === 'requester';
  return <dl className="event-facts" aria-label={t.context}>
    <dt>{t.status}</dt><dd>{t.statuses[detail.status]}</dd>
    <dt>{t.requester}</dt><dd>{detail.requester.full_name} · {detail.requester.masked_email}</dd>
    <dt>{t.assignee}</dt><dd>{detail.assignee?.full_name ?? t.unassigned}</dd>
    {event && <><dt>{t.event}</dt><dd><Link className="text-link" to={`/events/${event.id}`}>{event.title}</Link></dd></>}
    {order && <><dt>{t.order}</dt><dd>
      {requester ? <Link className="text-link" to={`/orders/${order.id}`}>{formatNumber(order.id)}</Link> : formatNumber(order.id)}
      {' · '}{ticketTypePrice(order.total_tiyn)}
    </dd></>}
    {ticket && <><dt>{t.ticket}</dt><dd>
      {requester ? <Link className="text-link" to={`/tickets/${ticket.id}`}>{formatNumber(ticket.id)}</Link> : formatNumber(ticket.id)}
    </dd></>}
  </dl>;
}

function HandlerControls({ detail, userId, pending, update }: {
  detail: SupportCase; userId: number; pending: boolean; update: (build: () => CaseUpdate) => void;
}) {
  const t = useT().support;
  const [status, setStatus] = useState<CaseStatus>(detail.status);
  const [assignee, setAssignee] = useState('');
  return <section aria-labelledby="support-controls">
    <h3 id="support-controls">{t.controls}</h3>
    <form className="support-form" onSubmit={event => {
      event.preventDefault();
      update(() => ({ status }));
    }}>
      <label>{t.status}<select value={status} disabled={pending} onChange={event => {
        const { value } = event.currentTarget;
        if (isOneOf(caseStatuses, value)) setStatus(value);
      }}>
        {caseStatuses.map(value => <option value={value} key={value}>{t.statuses[value]}</option>)}
      </select></label>
      <button className="button button-secondary" type="submit" disabled={pending || status === detail.status}>{t.saveStatus}</button>
    </form>
    <div className="organizer-links">
      {detail.assignee?.id !== userId && <button className="button button-secondary" type="button" disabled={pending}
        onClick={() => update(() => ({ assignee_id: userId }))}>{t.assignSelf}</button>}
      {detail.assignee && <button className="button button-secondary" type="button" disabled={pending}
        onClick={() => update(() => ({ assignee_id: null }))}>{t.unassign}</button>}
    </div>
    <form className="support-form" noValidate onSubmit={event => {
      event.preventDefault();
      update(() => {
        const id = parseSupportId(assignee.trim());
        if (id === null) throw new ApiError(text => text.support.invalidAssigneeId, { kind: 'validation' });
        return { assignee_id: id };
      });
    }}>
      <label>{t.assigneeId}<input required inputMode="numeric" value={assignee} disabled={pending}
        onChange={event => setAssignee(event.currentTarget.value)} /></label>
      <button className="button button-secondary" type="submit" disabled={pending}>{t.assign}</button>
    </form>
  </section>;
}
