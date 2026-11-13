import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';
import { Page } from '../components/Page';
import { formatEventDate } from '../events/catalog';
import { eventStatusLabel } from '../events/details';
import { canOrganize, organizerError, readManagedEvents } from '../organizer/model';
import type { ManagedEvent } from '../organizer/model';
import { useT } from '../i18n';

type State = { kind: 'loading' } | { kind: 'ready'; events: ManagedEvent[] } | { kind: 'error'; message: string };

/** Sign-in prompt or refusal shared by the organizer screens. Null when the account may continue. */
export function OrganizerGate({ allowed, returnTo }: { allowed: boolean; returnTo: string }) {
  const text = useT().organizer;
  const { user } = useAuth();
  if (!user) {
    return <div className="content-card narrow-card">
      <p>{text.signIn}</p>
      <Link className="button" to={authLink('/login', returnTo)}>{text.signInLink}</Link>
    </div>;
  }
  if (allowed) return null;
  return <div className="content-card narrow-card">
    <div className="notice notice-error" role="alert"><p>{text.noAccess}</p><p>{text.noAccessHint}</p></div>
    <Link className="button" to="/events">{text.toCatalog}</Link>
  </div>;
}

export function OrganizerPage() {
  const text = useT().organizer;
  const { user, request } = useAuth();
  const allowed = canOrganize(user);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    request('/events/mine', { signal: controller.signal }).then((payload) => {
      setState({ kind: 'ready', events: readManagedEvents(payload) });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        setState({ kind: 'error', message: organizerError(error) });
      }
    });
    return () => controller.abort();
  }, [allowed, attempt, request]);

  return (
    <Page eyebrow={text.eyebrow} title={text.list.title} description={text.list.description}>
      {!user || !allowed ? <OrganizerGate allowed={allowed} returnTo="/organizer" /> : (
        <section className="content-card" aria-labelledby="my-events">
          <h2 id="my-events">{text.list.heading}</h2>
          <p><Link className="button" to="/organizer/events/new">{text.list.create}</Link></p>
          {state.kind === 'loading' ? <p role="status">{text.list.loading}</p>
            : state.kind === 'error' ? (
              <div className="notice notice-error" role="alert">
                <h3>{text.list.loadFailed}</h3>
                <p>{state.message}</p>
                <button className="text-button" type="button" onClick={() => { setState({ kind: 'loading' }); setAttempt((value) => value + 1); }}>
                  {text.list.retry}
                </button>
              </div>
            ) : state.events.length === 0 ? <p role="status">{text.list.empty}</p> : (
              <ul className="organizer-events">
                {state.events.map((event) => (
                  <li key={event.id}>
                    <h3>{event.title}</h3>
                    <dl className="event-facts">
                      <dt>{text.list.status}</dt>
                      <dd>{eventStatusLabel(event.status)}{event.suspended && <span className="field-hint"> · {text.editor.suspended}</span>}</dd>
                      <dt>{text.list.when}</dt>
                      <dd><time dateTime={event.date}>{formatEventDate(event.date)}</time></dd>
                      <dt>{text.list.capacity}</dt><dd>{event.capacity ?? text.list.unknown}</dd>
                      <dt>{text.list.issued}</dt><dd>{event.tickets_issued ?? text.list.unknown}</dd>
                    </dl>
                    <p className="organizer-links">
                      <Link className="text-link" to={`/organizer/events/${event.id}/edit`} aria-label={`${text.list.edit}: ${event.title}`}>{text.list.edit}</Link>
                      <Link className="text-link" to={`/organizer/events/${event.id}/ticket-types`} aria-label={`${text.list.ticketTypes}: ${event.title}`}>{text.list.ticketTypes}</Link>
                      <Link className="text-link" to={`/events/${event.id}`} aria-label={`${text.list.open}: ${event.title}`}>{text.list.open}</Link>
                    </p>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}
    </Page>
  );
}
