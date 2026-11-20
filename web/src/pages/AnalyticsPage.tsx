import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { parseEventId } from '../events/details';
import { useT } from '../i18n';
import { formatNumber } from '../i18n/format';
import { canManageEvents } from '../organizer/model';
import { formatOrderAmount } from '../orders/model';
import { analyticsError, readAnalytics } from '../analytics/model';
import type { Analytics } from '../analytics/model';
import { OrganizerGate } from './OrganizerPage';

type Filters = { date_from: string; date_to: string; ticket_type_id: string };
type Row = { label: string; sold: number; net_sales_tiyn: number; redemptions?: number };
const initialFilters: Filters = { date_from: '', date_to: '', ticket_type_id: '' };

export function AnalyticsPage() {
  const t = useT();
  const { id } = useParams();
  const { user } = useAuth();
  const eventId = parseEventId(id);
  const allowed = canManageEvents(user);
  return <Page eyebrow={t.organizer.eyebrow} title={t.analytics.title} description={t.analytics.description}>
    {user && !allowed ? <p role="status">{t.analytics.notFound}</p> :
      <OrganizerGate allowed={allowed} returnTo={`/organizer/events/${id}/analytics`} />}
    {allowed && (eventId === null ? <p>{t.analytics.notFound}</p> :
      <AnalyticsReport key={`${user?.id}:${eventId}`} eventId={eventId} />)}
  </Page>;
}

function AnalyticsReport({ eventId }: { eventId: number }) {
  const t = useT();
  const copy = t.analytics;
  const { request } = useAuth();
  const [filters, setFilters] = useState(initialFilters);
  const [applied, setApplied] = useState(initialFilters);
  const [choices, setChoices] = useState<{ id: number; name: string }[]>([]);
  const [state, setState] = useState<{ report: Analytics } | { error: unknown } | null>(null);
  const [invalidRange, setInvalidRange] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(Object.entries(applied).filter(([, value]) => value !== ''));
    const query = params.size ? `?${params}` : '';
    request(`/events/${eventId}/analytics${query}`, { signal: controller.signal })
      .then(data => readAnalytics(data, eventId))
      .then(report => {
        if (controller.signal.aborted) return;
        if (!applied.ticket_type_id) setChoices(report.ticket_types);
        setState({ report });
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ error }); });
    return () => controller.abort();
  }, [applied, attempt, eventId, request]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = Boolean(filters.date_from && filters.date_to && filters.date_from > filters.date_to);
    setInvalidRange(invalid);
    if (invalid) return;
    setState(null);
    setApplied({ ...filters });
  }

  const report = state && 'report' in state ? state.report : null;
  return <>
    <form className="content-card auth-form analytics-filters" onSubmit={apply}>
      <label>{copy.from}<input type="date" value={filters.date_from}
        onChange={event => setFilters({ ...filters, date_from: event.target.value })} /></label>
      <label>{copy.to}<input type="date" value={filters.date_to}
        onChange={event => setFilters({ ...filters, date_to: event.target.value })} /></label>
      <label>{copy.ticketType}<select value={filters.ticket_type_id}
        onChange={event => setFilters({ ...filters, ticket_type_id: event.target.value })}>
        <option value="">{copy.allTypes}</option>
        {choices.map(kind => <option key={kind.id} value={kind.id}>{kind.name}</option>)}
      </select></label>
      <button className="button" type="submit">{copy.apply}</button>
      {invalidRange && <p role="alert">{copy.invalidRange}</p>}
    </form>
    {state === null && <p role="status">{copy.loading}</p>}
    {state && 'error' in state && <div className="notice notice-error" role="alert">
      <p>{analyticsError(state.error)}</p>
      <button type="button" className="button" onClick={() => { setState(null); setAttempt(n => n + 1); }}>{t.common.retry}</button>
    </div>}
    {report && <Report report={report} />}
  </>;
}

function Report({ report }: { report: Analytics }) {
  const copy = useT().analytics;
  const percent = (value: number) => formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 2 });
  const metrics: [string, string][] = [
    [copy.capacity, formatNumber(report.capacity)], [copy.sold, formatNumber(report.sold)],
    [copy.remaining, formatNumber(report.remaining)], [copy.percentSold, percent(report.percent_sold)],
    [copy.gross, formatOrderAmount(report.gross_before_discount_tiyn)],
    [copy.discounts, formatOrderAmount(report.discounts_tiyn)], [copy.refunds, formatOrderAmount(report.refunds_tiyn)],
    [copy.net, formatOrderAmount(report.net_sales_tiyn)], [copy.checkedIn, formatNumber(report.checked_in)],
    [copy.absent, formatNumber(report.absent)], [copy.percentCheckedIn, percent(report.percent_checked_in)],
  ];
  return <>
    <section className="content-card">
      <h2>{report.event_title}</h2>
      <p className="field-hint">{copy.capacityHint}</p>
      <dl className="analytics-metrics">
        {metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </section>
    <SalesTable title={copy.byDay} column={copy.date} chart rows={report.daily.map(row => ({ ...row, label: row.date }))} />
    <SalesTable title={copy.byType} column={copy.ticketType} chart rows={report.ticket_types.map(row => ({ ...row, label: row.name }))} />
    <SalesTable title={copy.byCampaign} column={copy.campaign} campaigns rows={report.campaigns.map(row => ({ ...row, label: row.name }))} />
  </>;
}

function SalesTable({ title, column, rows, chart, campaigns }: {
  title: string; column: string; rows: Row[]; chart?: boolean; campaigns?: boolean;
}) {
  const copy = useT().analytics;
  const displayed = rows.slice(-30);
  const width = 320 / Math.max(1, displayed.length);
  const largest = Math.max(1, ...displayed.map(row => row.sold));
  return <section className="content-card">
    <h2>{title}</h2>
    {chart && displayed.some(row => row.sold > 0) && <>
      <svg className="analytics-chart" viewBox="0 0 320 100" role="img" aria-label={`${title} · ${copy.sold}`}>
        <title>{`${title} · ${copy.sold}`}</title>
        {displayed.map((row, index) => {
          const height = 94 * row.sold / largest;
          return <rect key={index} x={index * width + width * 0.1} y={100 - height} width={width * 0.8} height={height}>
            <title>{`${row.label} · ${formatNumber(row.sold)}`}</title>
          </rect>;
        })}
      </svg>
      {rows.length > 30 && <p className="field-hint">{copy.chartLimit}</p>}
    </>}
    {rows.length === 0 ? <p>{copy.empty}</p> :
      <div className="table-scroll">
        <table className="ticket-types-table" aria-label={title}>
          <thead><tr><th scope="col">{column}</th>{campaigns && <th scope="col">{copy.redemptions}</th>}
            <th scope="col">{copy.sold}</th><th scope="col">{copy.net}</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>
            <th scope="row">{row.label}</th>{campaigns && <td>{formatNumber(row.redemptions ?? 0)}</td>}
            <td>{formatNumber(row.sold)}</td><td>{formatOrderAmount(row.net_sales_tiyn)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </section>;
}
