import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { eventStatusLabel } from '../events/details';
import { LOG_PAGE, SEARCH_LIMIT, actionLogPath, adminError, adminPath, isAdmin, readActionLogEntry, readAdminEvent, readAdminUser,
  readList, roleLabel, suspensionReason } from '../admin/model';
import type { ActionLogEntry, AdminEvent, AdminUser, LogFilters } from '../admin/model';
import { adminText as text } from '../admin/strings';

const readUsers = (payload: unknown) => readList(payload, readAdminUser);
const readEvents = (payload: unknown) => readList(payload, readAdminEvent);
const readLog = (payload: unknown) => readList(payload, readActionLogEntry);
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

/** Loads one admin list. A new path or a retry replaces the previous answer; a stale answer is dropped. */
function useAdminList<T>(path: string | null, read: (payload: unknown) => T[]) {
  const { request } = useAuth();
  const [state, setState] = useState<{ key: string; rows: T[] | null; error: string | null }>({ key: '', rows: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${path ?? ''}`;

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    request(path, { signal: controller.signal }).then((payload) => {
      setState({ key, rows: read(payload), error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) setState({ key, rows: null, error: adminError(error) });
    });
    return () => controller.abort();
  }, [path, key, read, request]);

  const loading = path !== null && state.key !== key;
  return {
    loading, rows: loading ? null : state.rows, error: loading ? null : state.error,
    retry: () => setAttempt((value) => value + 1),
    replace: (match: (row: T) => boolean, next: T) => setState((current) => ({
      ...current, rows: current.rows?.map((row) => (match(row) ? next : row)) ?? null,
    })),
  };
}

function ListState({ loading, error, empty, emptyText, retry }: { loading: boolean; error: string | null; empty: boolean; emptyText: string; retry: () => void }) {
  if (loading) return <p role="status">{text.searching}</p>;
  if (error !== null) {
    return <div className="notice notice-error" role="alert">
      <h3>{text.loadFailed}</h3><p>{error}</p>
      <button className="text-button" type="button" onClick={retry}>{text.retry}</button>
    </div>;
  }
  return empty ? <p role="status">{emptyText}</p> : null;
}

/** Suspend with a reason (second step) or lift a suspension. The API's refusal is shown by code. */
function SuspendControl({ suspended, subject, onSuspend, onReactivate }: {
  suspended: boolean;
  subject: string;
  onSuspend: (reason: string, signal: AbortSignal) => Promise<void>;
  onReactivate: (signal: AbortSignal) => Promise<void>;
}) {
  const { pending, error, submit } = useSubmission();
  const [asking, setAsking] = useState(false);
  const inputId = `reason-${subject.replace(/\W+/g, '-')}`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
    void submit(async (signal) => {
      await onSuspend(suspensionReason(reason), signal);
      if (!signal.aborted) setAsking(false);
    });
  }

  return <>
    {error !== null && <p className="notice notice-error" role="alert">{adminError(error)}</p>}
    {suspended ? (
      <button className="button" type="button" disabled={pending} aria-label={`${text.users.reactivate}: ${subject}`}
        onClick={() => { void submit(onReactivate); }}>{pending ? text.working : text.users.reactivate}</button>
    ) : asking ? (
      <form className="admin-reason" onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId}>{text.reason}</label>
        <input id={inputId} name="reason" maxLength={300} required disabled={pending} aria-describedby={`${inputId}-hint`} />
        <p className="field-hint" id={`${inputId}-hint`}>{text.reasonHint}</p>
        <button className="button button-secondary" type="submit" disabled={pending}>{pending ? text.working : text.confirmSuspend}</button>
        <button className="text-button" type="button" disabled={pending} onClick={() => setAsking(false)}>{text.keep}</button>
      </form>
    ) : (
      <button className="button button-secondary" type="button" aria-label={`${text.users.suspend}: ${subject}`}
        onClick={() => setAsking(true)}>{text.users.suspend}</button>
    )}
  </>;
}

function Table({ label, columns, children }: { label: string; columns: readonly string[]; children: ReactNode }) {
  return <div className="table-scroll">
    <table className="ticket-types-table" aria-label={label}>
      <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}

function Users() {
  const { user, request } = useAuth();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [active, setActive] = useState('');
  const list = useAdminList(adminPath('/admin/users', { q: query, limit: SEARCH_LIMIT }), readUsers);
  const [done, setDone] = useState<string | null>(null);
  const rows = (list.rows ?? []).filter((row) => (!role || row.role === role) && (!active || String(row.is_active) === active));

  async function change(target: AdminUser, action: 'suspend' | 'reactivate', signal: AbortSignal, reason?: string) {
    const saved = readAdminUser(await request(`/admin/users/${target.id}/${action}`, { method: 'POST', signal, ...(reason === undefined ? {} : { body: { reason } }) }));
    list.replace((row) => row.id === saved.id, saved);
    setDone(action === 'suspend' ? text.users.suspendedDone(saved.full_name) : text.users.reactivatedDone(saved.full_name));
  }

  const columns = text.users.columns;
  return <section className="content-card" aria-labelledby="admin-users">
    <h2 id="admin-users">{text.users.heading}</h2>
    <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setDone(null); setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim()); }}>
      <div><label htmlFor="users-q">{text.users.query}</label><input id="users-q" name="q" type="search" maxLength={100} /></div>
      <button className="button" type="submit">{text.search}</button>
      <div><label htmlFor="users-role">{text.users.role}</label>
        <select id="users-role" value={role} onChange={(event) => setRole(event.target.value)}>
          <option value="">{text.any}</option>
          {(['attendee', 'organizer', 'admin'] as const).map((name) => <option key={name} value={name}>{text.roles[name]}</option>)}
        </select></div>
      <div><label htmlFor="users-state">{text.users.state}</label>
        <select id="users-state" value={active} onChange={(event) => setActive(event.target.value)}>
          <option value="">{text.any}</option><option value="true">{text.users.active}</option><option value="false">{text.users.suspended}</option>
        </select></div>
    </form>
    <p className="field-hint">{text.filterNote} {list.rows?.length === SEARCH_LIMIT && text.limitNote(SEARCH_LIMIT)}</p>
    {done && <div className="notice notice-success" role="status"><p>{done}</p></div>}
    <ListState loading={list.loading} error={list.error} empty={list.rows !== null && rows.length === 0} emptyText={text.users.empty} retry={list.retry} />
    {rows.length > 0 && <Table label={text.users.heading} columns={[columns.name, columns.email, columns.role, columns.state, columns.created, columns.action]}>
      {rows.map((row) => <tr key={row.id}>
        <th scope="row">{row.full_name}</th>
        <td>{row.email}</td>
        <td>{roleLabel(row.role)}</td>
        <td>{row.is_active ? text.users.active : text.users.suspended}</td>
        <td><time dateTime={row.created_at}>{dateTime(row.created_at)}</time></td>
        <td>{row.id === user?.id ? <span className="field-hint">{text.users.self}</span> : (
          <SuspendControl suspended={!row.is_active} subject={row.email}
            onSuspend={(reason, signal) => change(row, 'suspend', signal, reason)} onReactivate={(signal) => change(row, 'reactivate', signal)} />
        )}</td>
      </tr>)}
    </Table>}
  </section>;
}

function Events() {
  const { request } = useAuth();
  const [query, setQuery] = useState('');
  const [suspended, setSuspended] = useState('');
  const [status, setStatus] = useState('');
  const list = useAdminList(adminPath('/admin/events', { q: query, suspended, limit: SEARCH_LIMIT }), readEvents);
  const [done, setDone] = useState<string | null>(null);
  const rows = (list.rows ?? []).filter((row) => !status || row.status === status);

  async function change(target: AdminEvent, action: 'suspend' | 'reactivate', signal: AbortSignal, reason?: string) {
    const saved = readAdminEvent(await request(`/admin/events/${target.id}/${action}`, { method: 'POST', signal, ...(reason === undefined ? {} : { body: { reason } }) }));
    list.replace((row) => row.id === saved.id, saved);
    setDone(action === 'suspend' ? text.events.suspendedDone(saved.title) : text.events.reactivatedDone(saved.title));
  }

  const columns = text.events.columns;
  return <section className="content-card" aria-labelledby="admin-events">
    <h2 id="admin-events">{text.events.heading}</h2>
    <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setDone(null); setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim()); }}>
      <div><label htmlFor="events-q">{text.events.query}</label><input id="events-q" name="q" type="search" maxLength={100} /></div>
      <button className="button" type="submit">{text.search}</button>
      <div><label htmlFor="events-suspended">{text.events.suspension}</label>
        <select id="events-suspended" value={suspended} onChange={(event) => { setDone(null); setSuspended(event.target.value); }}>
          <option value="">{text.any}</option><option value="true">{text.events.onlySuspended}</option><option value="false">{text.events.notSuspended}</option>
        </select></div>
      <div><label htmlFor="events-status">{text.events.status}</label>
        <select id="events-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{text.any}</option>
          {(['draft', 'published', 'cancelled'] as const).map((name) => <option key={name} value={name}>{eventStatusLabel(name)}</option>)}
        </select></div>
    </form>
    <p className="field-hint">{text.filterNote} {list.rows?.length === SEARCH_LIMIT && text.limitNote(SEARCH_LIMIT)}</p>
    {done && <div className="notice notice-success" role="status"><p>{done}</p></div>}
    <ListState loading={list.loading} error={list.error} empty={list.rows !== null && rows.length === 0} emptyText={text.events.empty} retry={list.retry} />
    {rows.length > 0 && <Table label={text.events.heading} columns={[columns.title, columns.status, columns.when, columns.issued, columns.suspension, columns.action]}>
      {rows.map((row) => <tr key={row.id}>
        <th scope="row"><Link className="text-link" to={`/events/${row.id}`}>{row.title}</Link></th>
        <td>{eventStatusLabel(row.status)}</td>
        <td><time dateTime={row.date}>{dateTime(row.date)}</time></td>
        <td>{row.tickets_issued ?? '?'} / {row.capacity ?? '?'}</td>
        <td>{row.suspended_at === null ? text.events.notSuspendedCell : text.events.suspendedSince(dateTime(row.suspended_at))}</td>
        <td><SuspendControl suspended={row.suspended_at !== null} subject={`${row.title} #${row.id}`}
          onSuspend={(reason, signal) => change(row, 'suspend', signal, reason)} onReactivate={(signal) => change(row, 'reactivate', signal)} /></td>
      </tr>)}
    </Table>}
  </section>;
}

const noFilters: LogFilters = { action: '', eventId: '', from: '', to: '' };

function ActionLog() {
  const [filters, setFilters] = useState<LogFilters>(noFilters);
  const [offset, setOffset] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [path, setPath] = useState(() => actionLogPath(noFilters, 0));
  const list = useAdminList<ActionLogEntry>(path, readLog);

  function show(next: LogFilters, nextOffset: number) {
    try {
      setPath(actionLogPath(next, nextOffset));
      setFilters(next);
      setOffset(nextOffset);
      setProblem(null);
    } catch (error) {
      setProblem(adminError(error));
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) ?? '');
    show({ action: value('action'), eventId: value('event_id'), from: value('from'), to: value('to') }, 0);
  }

  const rows = list.rows ?? [];
  const columns = text.log.columns;
  return <section className="content-card" aria-labelledby="admin-log">
    <h2 id="admin-log">{text.log.heading}</h2>
    <p className="field-hint">{text.log.readOnly}</p>
    <form className="admin-filters" onSubmit={onSubmit} noValidate>
      <div><label htmlFor="log-action">{text.log.action}</label>
        <input id="log-action" name="action" maxLength={80} aria-describedby="log-action-hint" />
        <p className="field-hint" id="log-action-hint">{text.log.actionHint}</p></div>
      <div><label htmlFor="log-event">{text.log.eventId}</label><input id="log-event" name="event_id" inputMode="numeric" maxLength={10} /></div>
      <div><label htmlFor="log-from">{text.log.from}</label><input id="log-from" name="from" type="datetime-local" /></div>
      <div><label htmlFor="log-to">{text.log.to}</label><input id="log-to" name="to" type="datetime-local" /></div>
      <button className="button" type="submit">{text.search}</button>
    </form>
    {problem !== null && <p className="notice notice-error" role="alert">{problem}</p>}
    <ListState loading={list.loading} error={list.error} empty={list.rows !== null && rows.length === 0} emptyText={text.log.empty} retry={list.retry} />
    {rows.length > 0 && <Table label={text.log.heading} columns={[columns.time, columns.actor, columns.action, columns.entity, columns.event, columns.description]}>
      {rows.map((row) => <tr key={row.id}>
        <td><time dateTime={row.occurred_at}>{dateTime(row.occurred_at)}</time></td>
        <td>{row.actor_name} <span className="field-hint">#{row.actor_id}</span></td>
        <td><code>{row.action}</code></td>
        <td>{row.entity_type} #{row.entity_id}</td>
        <td>{row.event_id === null ? text.log.platform : <Link className="text-link" to={`/events/${row.event_id}`}>#{row.event_id}</Link>}</td>
        <td>{row.description}</td>
      </tr>)}
    </Table>}
    {list.rows !== null && (offset > 0 || rows.length === LOG_PAGE) && <p className="admin-pages">
      <button className="text-button" type="button" disabled={offset === 0} onClick={() => show(filters, Math.max(0, offset - LOG_PAGE))}>{text.log.previous}</button>
      <span>{rows.length > 0 ? text.log.page(offset + 1, offset + rows.length) : text.log.empty}</span>
      <button className="text-button" type="button" disabled={rows.length < LOG_PAGE} onClick={() => show(filters, offset + LOG_PAGE)}>{text.log.next}</button>
    </p>}
  </section>;
}

const sections = { users: Users, events: Events, 'action-log': ActionLog } as const;

export function AdminPage() {
  const { user } = useAuth();
  const { section = 'users' } = useParams();
  const Section = Object.hasOwn(sections, section) ? sections[section as keyof typeof sections] : null;

  return (
    <Page eyebrow={text.eyebrow} title={text.title} description={text.description}>
      {!user ? (
        <div className="content-card narrow-card">
          <p>{text.signIn}</p>
          <Link className="button" to={authLink('/login', '/events')}>{text.signInLink}</Link>
        </div>
      ) : !isAdmin(user) ? (
        <div className="content-card narrow-card">
          <div className="notice notice-error" role="alert"><h2>{text.forbiddenTitle}</h2><p>{text.forbidden}</p></div>
          <Link className="button" to="/events">{text.toCatalog}</Link>
        </div>
      ) : Section === null ? <Navigate to="/admin/users" replace /> : (
        <>
          <nav className="admin-tabs" aria-label={text.tabs.label}>
            <NavLink className="nav-link" to="/admin/users">{text.tabs.users}</NavLink>
            <NavLink className="nav-link" to="/admin/events">{text.tabs.events}</NavLink>
            <NavLink className="nav-link" to="/admin/action-log">{text.tabs.log}</NavLink>
          </nav>
          <Section />
        </>
      )}
    </Page>
  );
}
