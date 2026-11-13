import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { eventStatusLabel, parseEventId } from '../events/details';
import { canManageEvents, canOrganize, emptyEventDraft, eventDraft, eventPayload, organizerError, readManagedEvent } from '../organizer/model';
import type { EventDraft, ManagedEvent } from '../organizer/model';
import { useT } from '../i18n';
import { OrganizerGate } from './OrganizerPage';

type Load = { kind: 'loading' } | { kind: 'ready'; event: ManagedEvent } | { kind: 'notFound' } | { kind: 'error'; message: string };

function Problem({ error }: { error: unknown }) {
  if (error === null) return null;
  return (
    <div className="notice notice-error" role="alert" id="form-error">
      <p>{organizerError(error)}</p>
      {error instanceof ApiError && error.issues.length > 0 && (
        <ul>{error.issues.map((issue, index) => <li key={`${issue.field}-${index}`}>{issue.message}</li>)}</ul>
      )}
    </div>
  );
}

function EventForm({ original, onSaved }: { original?: ManagedEvent; onSaved: (event: ManagedEvent, changed: boolean) => void }) {
  const text = useT().organizer;
  const { request } = useAuth();
  const { pending, error, submit } = useSubmission();
  const [draft, setDraft] = useState<EventDraft>(() => (original ? eventDraft(original) : emptyEventDraft()));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const field = (name: keyof EventDraft) => ({
    name, value: draft[name],
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [name]: event.target.value })),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(async (signal) => {
      const body = eventPayload(draft, original);
      if (original && Object.keys(body).length === 0) { onSaved(original, false); return; }
      const saved = await request(original ? `/events/${original.id}` : '/events', { method: original ? 'PATCH' : 'POST', body, signal });
      const id = original?.id ?? (typeof saved === 'object' && saved !== null && 'id' in saved && typeof saved.id === 'number' ? saved.id : 0);
      if (!signal.aborted) onSaved(readManagedEvent(saved, id), true);
    });
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate aria-busy={pending} aria-describedby={error ? 'form-error' : undefined}>
      <Problem error={error} />
      <fieldset disabled={pending}>
        <label htmlFor="event-title">{text.editor.title}</label>
        <input id="event-title" {...field('title')} required maxLength={200} />
        <label htmlFor="event-description">{text.editor.description}</label>
        <textarea id="event-description" {...field('description')} rows={5} maxLength={5000} />
        <label htmlFor="event-date">{text.editor.date}</label>
        <input id="event-date" type="datetime-local" {...field('date')} required aria-describedby="event-date-hint" />
        <p className="field-hint" id="event-date-hint">{text.editor.dateHint(zone)}</p>
        <label htmlFor="event-location">{text.editor.location}</label>
        <input id="event-location" {...field('location')} required maxLength={255} />
        <label htmlFor="event-capacity">{text.editor.capacity}</label>
        <input id="event-capacity" inputMode="numeric" {...field('capacity')} required maxLength={7} />
        <button className="button" type="submit" disabled={pending}>
          {pending ? text.editor.saving : original ? text.editor.save : text.editor.create}
        </button>
      </fieldset>
    </form>
  );
}

function StatusActions({ event, onChanged }: { event: ManagedEvent; onChanged: (event: ManagedEvent, notice: string) => void }) {
  const text = useT().organizer;
  const { request } = useAuth();
  const { pending, error, submit } = useSubmission();
  const [confirming, setConfirming] = useState(false);

  function act(action: 'publish' | 'cancel', notice: string) {
    void submit(async (signal) => {
      const saved = await request(`/events/${event.id}/${action}`, { method: 'POST', signal });
      if (signal.aborted) return;
      setConfirming(false);
      onChanged(readManagedEvent(saved, event.id), notice);
    });
  }

  return (
    <section className="content-card" aria-labelledby="event-status">
      <h2 id="event-status">{text.editor.statusHeading}</h2>
      <p>{text.list.status}: <strong>{eventStatusLabel(event.status)}</strong></p>
      {event.suspended && <div className="notice notice-error" role="status"><p>{text.editor.suspended}</p></div>}
      {event.status === 'cancelled' && <p>{text.editor.cancelledLocked}</p>}
      <Problem error={error} />
      {confirming ? (
        <div className="notice" role="group" aria-label={text.editor.cancel}>
          <p>{text.editor.cancelQuestion}</p>
          <p className="event-status-actions">
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => act('cancel', text.editor.cancelled)}>
              {pending ? text.editor.working : text.editor.cancelConfirm}
            </button>
            <button className="text-button" type="button" disabled={pending} onClick={() => setConfirming(false)}>{text.editor.cancelKeep}</button>
          </p>
        </div>
      ) : event.status !== 'cancelled' && (
        <p className="event-status-actions">
          {event.status === 'draft' && (
            <button className="button" type="button" disabled={pending} onClick={() => act('publish', text.editor.published)}>
              {pending ? text.editor.working : text.editor.publish}
            </button>
          )}
          <button className="button button-secondary" type="button" disabled={pending} onClick={() => setConfirming(true)}>{text.editor.cancel}</button>
        </p>
      )}
      <p className="organizer-links">
        <Link className="text-link" to={`/organizer/events/${event.id}/ticket-types`}>{text.list.ticketTypes}</Link>
        <Link className="text-link" to={`/events/${event.id}`}>{text.list.open}</Link>
      </p>
    </section>
  );
}

/** One screen for "new" and "edit". Each event gets its own instance, so no state leaks between events. */
export function EventEditorPage() {
  const { id } = useParams();
  return <EventEditor key={id ?? 'new'} id={id} />;
}

function EventEditor({ id }: { id: string | undefined }) {
  const text = useT().organizer;
  const creating = id === undefined;
  const eventId = creating ? null : parseEventId(id);
  const { user, request } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const allowed = creating ? canOrganize(user) : canManageEvents(user);
  const [load, setLoad] = useState<Load>(() => (creating ? { kind: 'notFound' } : eventId === null ? { kind: 'notFound' } : { kind: 'loading' }));
  const [notice, setNotice] = useState<string | null>(location.state?.created === true ? text.editor.created : null);

  useEffect(() => {
    if (creating || eventId === null || !allowed) return;
    const controller = new AbortController();
    request(`/events/${eventId}`, { signal: controller.signal }).then((payload) => {
      setLoad({ kind: 'ready', event: readManagedEvent(payload, eventId) });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      setLoad(error instanceof ApiError && error.status === 404 ? { kind: 'notFound' } : { kind: 'error', message: organizerError(error) });
    });
    return () => controller.abort();
  }, [creating, eventId, allowed, request]);

  const returnTo = creating ? '/organizer/events/new' : `/organizer/events/${id}/edit`;
  return (
    <Page eyebrow={text.eyebrow} title={creating ? text.editor.createTitle : text.editor.editTitle}
      description={creating ? text.editor.createDescription : text.editor.editDescription}>
      {!user || !allowed ? <OrganizerGate allowed={allowed} returnTo={returnTo} /> : creating ? (
        <div className="content-card">
          <EventForm onSaved={(event) => navigate(`/organizer/events/${event.id}/edit`, { replace: true, state: { created: true } })} />
        </div>
      ) : load.kind === 'loading' ? <p role="status">{text.editor.loading}</p>
        : load.kind === 'notFound' ? <p role="status">{text.editor.notFound}</p>
          : load.kind === 'error' ? <div className="notice notice-error" role="alert"><p>{load.message}</p></div> : (
            <>
              {notice && <div className="notice notice-success" role="status"><p>{notice}</p></div>}
              <StatusActions event={load.event} onChanged={(event, message) => { setLoad({ kind: 'ready', event }); setNotice(message); }} />
              <div className="content-card">
                <h2>{load.event.title}</h2>
                <EventForm key={load.event.id} original={load.event}
                  onSaved={(event, changed) => { setLoad({ kind: 'ready', event }); setNotice(changed ? text.editor.saved : text.editor.unchanged); }} />
              </div>
            </>
          )}
      {user && canOrganize(user) && <p><Link className="text-link" to="/organizer">{text.editor.backToList}</Link></p>}
    </Page>
  );
}
