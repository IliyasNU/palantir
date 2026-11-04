import { useEffect, useState } from 'react';
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
            ? 'Каталог недоступен на подключённом сервере (HTTP 405). Обратитесь к команде сервиса.'
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
      eyebrow="Афиша BiletFlow"
      title="Найдите повод быть вместе."
      description="Концерты, встречи и новые впечатления — всё начинается с события."
    >
      <div className="catalog-search" role="search" aria-label="Поиск событий">
        <label htmlFor="event-search">Поиск по названию</label>
        <div className="catalog-search-controls">
          <input
            id="event-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Название события"
          />
          {query && <button className="text-button" type="button" onClick={() => setQuery('')}>Сбросить поиск</button>}
        </div>
      </div>
      {state.kind === 'loading' && <p role="status">Загружаем события…</p>}
      {state.kind === 'error' && (
        <div className="notice notice-error catalog-state" role="alert">
          <h2>Не удалось загрузить события</h2>
          <p>{state.message}</p>
          <button className="button" type="button" onClick={retry}>Повторить</button>
        </div>
      )}
      {state.kind === 'success' && (
        state.events.length === 0 ? (
          <div className="content-card" role="status">
            <h2>Событий пока нет</h2>
            <p>Опубликованные события появятся здесь.</p>
          </div>
        ) : visibleEvents.length === 0 ? (
          <div className="content-card" role="status">
            <h2>Ничего не найдено</h2>
            <p>По этому названию совпадений нет. Попробуйте другой запрос или сбросьте поиск.</p>
          </div>
        ) : (
          <>
            <p className="catalog-count" role="status">Найдено событий: {visibleEvents.length}</p>
            <p className="field-hint catalog-time-hint">Дата и время указаны в вашем местном часовом поясе.</p>
            <ul className="event-grid" aria-label="События">
              {visibleEvents.map((event) => (
                <li key={event.id}>
                  <article className="content-card event-card">
                    <h2><Link className="text-link" to={`/events/${event.id}`}>{event.title}</Link></h2>
                    <dl>
                      <dt>Когда</dt>
                      <dd><time dateTime={event.date}>{formatEventDate(event.date)}</time></dd>
                      <dt>Где</dt>
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
