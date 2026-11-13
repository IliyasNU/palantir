import { useEffect, useState } from 'react';
import { current, useT } from '../i18n';
import { Link } from 'react-router';
import { api, ApiError, getErrorMessage } from '../api';
import { Page } from '../components/Page';
import { filterEventsByTitle, formatEventDate, readCatalog } from '../events/catalog';
import type { CatalogEvent } from '../events/catalog';

type CatalogState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; events: CatalogEvent[] };

export function EventsPage() {
  const t = useT();
  const [state, setState] = useState<CatalogState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.request<unknown>('/events', { signal: controller.signal })
      .then(readCatalog)
      .then((events) => {
        if (!controller.signal.aborted) setState({ kind: 'success', events });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({
          kind: 'error',
          message: error instanceof ApiError && error.status === 405
            ? current().catalog.unavailable
            : getErrorMessage(error),
        });
      });
    return () => controller.abort();
  }, [attempt]);

  function retry() {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  const visibleEvents = state.kind === 'success' ? filterEventsByTitle(state.events, query) : [];

  return (
    <Page
      eyebrow={t.catalog.eyebrow}
      title={t.catalog.title}
      description={t.catalog.description}
    >
      <div className="catalog-search" role="search" aria-label={t.catalog.searchLabel}>
        <label htmlFor="event-search">{t.catalog.searchField}</label>
        <div className="catalog-search-controls">
          <input
            id="event-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.catalog.searchPlaceholder}
          />
          {query && <button className="text-button" type="button" onClick={() => setQuery('')}>{t.catalog.reset}</button>}
        </div>
      </div>
      {state.kind === 'loading' && <p role="status">{t.catalog.loading}</p>}
      {state.kind === 'error' && (
        <div className="notice notice-error catalog-state" role="alert">
          <h2>{t.catalog.loadFailed}</h2>
          <p>{state.message}</p>
          <button className="button" type="button" onClick={retry}>{t.common.retry}</button>
        </div>
      )}
      {state.kind === 'success' && (
        state.events.length === 0 ? (
          <div className="content-card" role="status">
            <h2>{t.catalog.emptyTitle}</h2>
            <p>{t.catalog.emptyText}</p>
          </div>
        ) : visibleEvents.length === 0 ? (
          <div className="content-card" role="status">
            <h2>{t.catalog.noMatchTitle}</h2>
            <p>{t.catalog.noMatchText}</p>
          </div>
        ) : (
          <>
            <p className="catalog-count" role="status">{t.catalog.found(visibleEvents.length)}</p>
            <p className="field-hint catalog-time-hint">{t.catalog.timeHint}</p>
            <ul className="event-grid" aria-label={t.catalog.listLabel}>
              {visibleEvents.map((event) => (
                <li key={event.id}>
                  <article className="content-card event-card">
                    <h2><Link className="text-link" to={`/events/${event.id}`}>{event.title}</Link></h2>
                    <dl>
                      <dt>{t.catalog.when}</dt>
                      <dd><time dateTime={event.date}>{formatEventDate(event.date)}</time></dd>
                      <dt>{t.catalog.where}</dt>
                      <dd>{event.location}</dd>
                    </dl>
                  </article>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </Page>
  );
}
