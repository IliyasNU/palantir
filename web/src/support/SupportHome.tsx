import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { isAdmin } from '../admin/model';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { useT } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { caseKinds, caseListPath, caseStatuses, isOneOf, pageSize, parseSupportId, readCaseList, supportError } from './model';
import type { CaseKind, CaseStatus } from './model';

export function SupportSignIn() {
  const t = useT();
  const location = useLocation();
  return <div className="content-card">
    <p>{t.support.login}</p>
    <Link className="button" to={authLink('/login', location.pathname + location.search)}>{t.common.login}</Link>
  </div>;
}

export function SupportHome({ queue }: { queue: 'mine' | 'event' | 'admin' }) {
  const t = useT().support;
  const { user } = useAuth();
  const { id } = useParams();
  const eventId = parseSupportId(id);
  const title = queue === 'mine' ? t.mine : queue === 'event' ? t.eventQueue : t.adminQueue;
  const endpoint = queue === 'mine' ? '/support/cases/mine'
    : queue === 'event' ? `/events/${eventId}/support-cases` : '/admin/support-cases';
  const canView = queue === 'mine' || isAdmin(user) || (queue === 'event' && user?.role === 'organizer');

  return <Page eyebrow={t.menu} title={title} description={queue === 'mine' ? t.mineDescription : t.queueDescription}>
    {!user ? <SupportSignIn />
      : !canView ? <p className="notice notice-error" role="alert">{t.errors.FORBIDDEN}</p>
      : queue === 'event' && eventId === null ? <p className="notice notice-error" role="alert">{t.errors.EVENT_NOT_FOUND}</p>
      : <>
        <div className="organizer-links">
          {queue !== 'mine' && <Link className="text-link" to="/support">{t.mine}</Link>}
          {queue === 'mine' && user.role === 'organizer' && <Link className="button" to="/support/new?kind=organizer">{t.platformNew}</Link>}
          {queue === 'mine' && isAdmin(user) && <Link className="button" to="/admin/support">{t.adminQueue}</Link>}
        </div>
        <CaseList key={`${user.id}:${endpoint}`} endpoint={endpoint} admin={queue === 'admin'} />
      </>}
  </Page>;
}

type ListState = { loading: true } | { loading: false; cases: ReturnType<typeof readCaseList> } | { loading: false; error: unknown };

function CaseList({ endpoint, admin }: { endpoint: string; admin: boolean }) {
  const t = useT().support;
  const { request } = useAuth();
  const [state, setState] = useState<ListState>({ loading: true });
  const [filters, setFilters] = useState<{ offset: number; status: CaseStatus | ''; kind: CaseKind | ''; attempt: number }>(
    { offset: 0, status: '', kind: '', attempt: 0 },
  );

  useEffect(() => {
    const controller = new AbortController();
    const path = caseListPath(endpoint, filters.offset, filters.status, filters.kind);
    void request(path, { signal: controller.signal }).then(readCaseList).then(cases => {
      if (!controller.signal.aborted) setState({ loading: false, cases });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ loading: false, error });
    });
    return () => controller.abort();
  }, [request, endpoint, filters]);

  function reload(next: Partial<typeof filters> = {}) {
    setState({ loading: true });
    setFilters(prev => ({ ...prev, ...next, attempt: prev.attempt + 1 }));
  }

  return <section className="content-card support-panel" aria-busy={state.loading}>
    <div className="support-filters">
      <label>{t.status}
        <select value={filters.status} onChange={event => {
          const { value } = event.currentTarget;
          reload({ status: isOneOf(caseStatuses, value) ? value : '', offset: 0 });
        }}>
          <option value="">{t.allStatuses}</option>
          {caseStatuses.map(status => <option key={status} value={status}>{t.statuses[status]}</option>)}
        </select>
      </label>
      {admin && <label>{t.kind}
        <select value={filters.kind} onChange={event => {
          const { value } = event.currentTarget;
          reload({ kind: isOneOf(caseKinds, value) ? value : '', offset: 0 });
        }}>
          <option value="">{t.allKinds}</option>
          {caseKinds.map(kind => <option key={kind} value={kind}>{t.kinds[kind]}</option>)}
        </select>
      </label>}
    </div>
    {state.loading ? <p role="status">{t.loading}</p>
      : 'error' in state ? <div className="notice notice-error" role="alert">
        <p>{supportError(state.error, t)}</p>
        <button type="button" className="text-button" onClick={() => reload()}>{t.retry}</button>
      </div> : <>
        {state.cases.length === 0 ? <p role="status">{t.empty}</p>
          : <ul className="organizer-events">
            {state.cases.slice(0, pageSize).map(item => <li key={item.id}>
              <h2><Link className="text-link" to={`/support/cases/${item.id}`}>{item.subject}</Link></h2>
              <p>{t.kinds[item.kind]} · {t.categories[item.category]} · {t.statuses[item.status]}</p>
              {item.event_title && <p>{item.event_title}</p>}
              <p>{t.lastMessage} · {t.sides[item.last_message_by]} ·{' '}
                <time dateTime={item.last_message_at}>{formatDateTime(item.last_message_at, 'medium')}</time>
              </p>
            </li>)}
          </ul>}
        <div className="organizer-links">
          {filters.offset > 0 && <button className="button button-secondary" type="button"
            onClick={() => reload({ offset: filters.offset - pageSize })}>{t.previous}</button>}
          {state.cases.length > pageSize && <button className="button button-secondary" type="button"
            onClick={() => reload({ offset: filters.offset + pageSize })}>{t.next}</button>}
        </div>
      </>}
  </section>;
}
