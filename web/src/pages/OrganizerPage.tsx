import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, getErrorMessage } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { canUseOrganizerPage, readOrganizerEvents, statusLabel } from 
'../organizer/model';
import type { OrganizerEvent } from '../organizer/model';
export function OrganizerPage() {
const { user, request } = useAuth();
return <Page eyebrow="Для организаторов" title="Кабинет организатора"
description="Ваши события во всех статусах: черновики, опубликованные и 
отменённые.">
{!user ? <p><Link className="button" to={authLink('/login', 
'/organizer')}>Войти как организатор</Link></p>
: !canUseOrganizerPage(user.role) ? <div className="notice notice
error" role="alert">
<p>Кабинет доступен только организаторам.</p>
<p><Link className="text-link" to="/events">Вернуться к 
Page 6 of 19
событиям</Link></p>
      </div>
      : <OrganizerEvents key={user.id} request={request} />}
  </Page>;
}
function OrganizerEvents({ request }: { request: typeof api.request }) {
  const [events, setEvents] = useState<OrganizerEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setEvents(null);
    setError(null);
    request('/events/mine', { signal: controller.signal 
}).then(readOrganizerEvents)
      .then((result) => { if (!controller.signal.aborted) setEvents(result); 
})
      .catch((failure: unknown) => { if (!controller.signal.aborted) 
setError(getErrorMessage(failure)); });
    return () => controller.abort();
  }, [request, attempt]);
  if (error) return <div className="notice notice-error" role="alert"><p>
{error}</p>
    <button className="button" type="button" onClick={() => 
setAttempt((value) => value + 1)}>Повторить</button></div>;
  if (events === null) return <p role="status">Загружаем ваши события…</p>;
  if (events.length === 0) return <p role="status">У вас пока нет событий.
</p>;
  return <ul className="event-grid" aria-label="Мои события">
    {events.map((event) => <li key={event.id}><article className="content
card event-card">
      <h2>{event.title}</h2>
      <p><time dateTime={event.date}>{formatEventDate(event.date)}</time></p>
      <p>{event.location}</p>
      <p>{statusLabel[event.status]} · выдано {event.tickets_issued} из 
{event.capacity}</p>
    </article></li>)}
  </ul>;
}