import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, issueMessage } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { eventStatusLabel, parseEventId } from '../events/details';
import { canManageEvents, canOrganize, emptyEventDraft, eventDraft, eventPayload, organizerError, readManagedEvent, readStaffMembers, staffError } from '../organizer/model';
import type { EventDraft, ManagedEvent, StaffMember } from '../organizer/model';
import { useT } from '../i18n';
import { OrganizerGate } from './OrganizerPage';

type Load = { kind: 'loading' } | { kind: 'ready'; event: ManagedEvent } | { kind: 'notFound' } | { kind: 'error'; error: unknown };
/** Which confirmation to show; its text is picked while rendering, in the current language. */
type Notice = 'created' | 'saved' | 'unchanged' | 'published' | 'cancelled';

function Problem({ error }: { error: unknown }) {
  if (error === null) return null;
  return (
    <div className="notice notice-error" role="alert" id="form-error">
      <p>{organizerError(error)}</p>
      {error instanceof ApiError && error.issues.length > 0 && (
        <ul>{error.issues.map((issue, index) => <li key={`${issue.field}-${index}`}>{issueMessage(issue)}</li>)}</ul>
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

function StaffManager({ event }: { event: ManagedEvent }) {
  const text = useT().organizer;
  const { request } = useAuth();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    request(`/events/${event.id}/staff`, { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setStaff(readStaffMembers(payload)); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(staffError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [event.id, request]);

  async function assign(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (pending) return;
    setPending(true); setError(null); setNotice(null);
    try {
      await request(`/events/${event.id}/staff`, { method: 'POST', body: { email: email.trim() } });
      setEmail('');
      setStaff(readStaffMembers(await request(`/events/${event.id}/staff`)));
      setNotice(text.staff.assigned);
    } catch (failure: unknown) {
      setError(staffError(failure));
    } finally {
      setPending(false);
    }
  }

  async function remove(userId: number) {
    if (pending) return;
    setPending(true); setError(null); setNotice(null);
    try {
      await request(`/events/${event.id}/staff/${userId}`, { method: 'DELETE' });
      setStaff((current) => current.filter((member) => member.user_id !== userId));
      setNotice(text.staff.removed);
    } catch (failure: unknown) {
      setError(staffError(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="content-card" aria-labelledby="event-staff">
      <h2 id="event-staff">{text.staff.heading}</h2>
      {error && <div className="notice notice-error" role="alert"><p>{error}</p></div>}
      {notice && <div className="notice notice-success" role="status"><p>{notice}</p></div>}
      <form className="auth-form" onSubmit={assign} noValidate>
        <fieldset disabled={pending}>
          <label htmlFor="staff-email">{text.staff.email}</label>
          <input id="staff-email" type="email" value={email} onChange={(change) => setEmail(change.target.value)} required />
          <button className="button" type="submit" disabled={!email.trim()}>{pending ? text.staff.removing : text.staff.add}</button>
        </fieldset>
      </form>
      {loading ? <p role="status">{text.staff.loading}</p> : staff.length === 0
        ? <p role="status">{text.staff.empty}</p>
        : <ul>{staff.map((member) => (
          <li key={member.user_id}>
            <strong>{member.full_name}</strong> — {member.email}{' '}
            <button className="text-button" type="button" disabled={pending} onClick={() => void remove(member.user_id)}>{text.staff.remove}</button>
          </li>
        ))}</ul>}
    </section>
  );
}

function StatusActions({ event, onChanged }: { event: ManagedEvent; onChanged: (event: ManagedEvent, notice: Notice) => void }) {
  const text = useT().organizer;
  const { request } = useAuth();
  const { pending, error, submit } = useSubmission();
  const [confirming, setConfirming] = useState(false);
  // "Keep the event" gives focus back to the button that asked, so keyboard users keep their place.
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (confirming || !restoreFocus.current) return;
    restoreFocus.current = false;
    cancelButton.current?.focus();
  }, [confirming]);

  function act(action: 'publish' | 'cancel', notice: Notice) {
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
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => act('cancel', 'cancelled')}>
              {pending ? text.editor.working : text.editor.cancelConfirm}
            </button>
            {/* The irreversible question starts on the safe answer. */}
            <button className="text-button" type="button" disabled={pending} autoFocus
              onClick={() => { restoreFocus.current = true; setConfirming(false); }}>{text.editor.cancelKeep}</button>
          </p>
        </div>
      ) : event.status !== 'cancelled' && (
        <p className="event-status-actions">
          {event.status === 'draft' && (
            <button className="button" type="button" disabled={pending} onClick={() => act('publish', 'published')}>
              {pending ? text.editor.working : text.editor.publish}
            </button>
          )}
          <button ref={cancelButton} className="button button-secondary" type="button" disabled={pending} onClick={() => setConfirming(true)}>{text.editor.cancel}</button>
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
  const [notice, setNotice] = useState<Notice | null>(location.state?.created === true ? 'created' : null);

  useEffect(() => {
    if (creating || eventId === null || !allowed) return;
    const controller = new AbortController();
    request(`/events/${eventId}`, { signal: controller.signal }).then((payload) => {
      setLoad({ kind: 'ready', event: readManagedEvent(payload, eventId) });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      setLoad(error instanceof ApiError && error.status === 404 ? { kind: 'notFound' } : { kind: 'error', error });
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
          : load.kind === 'error' ? <div className="notice notice-error" role="alert"><p>{organizerError(load.error)}</p></div> : (
            <>
              {notice && <div className="notice notice-success" role="status"><p>{text.editor[notice]}</p></div>}
              <StatusActions event={load.event} onChanged={(event, message) => { setLoad({ kind: 'ready', event }); setNotice(message); }} />
              <StaffManager event={load.event} />
              <div className="content-card">
                <h2>{load.event.title}</h2>
                <EventForm key={load.event.id} original={load.event}
                  onSaved={(event, changed) => { setLoad({ kind: 'ready', event }); setNotice(changed ? 'saved' : 'unchanged'); }} />
              </div>
            </>
          )}
      {user && canOrganize(user) && <p><Link className="text-link" to="/organizer">{text.editor.backToList}</Link></p>}
    </Page>
  );
}
