import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';
import { useT } from '../i18n';
import { canOrganize, emptyOrganizerProfileDraft, organizerProfileDraft, organizerProfilePayload, readOrganizerProfile } from '../organizer/model';
import type { OrganizerProfile, OrganizerProfileDraft } from '../organizer/model';
import { OrganizerGate } from './OrganizerPage';

export function OrganizerProfilePage() {
  const text = useT().organizer;
  const { user, request } = useAuth();
  const allowed = canOrganize(user);
  const [profile, setProfile] = useState<OrganizerProfile | null>(null);
  const [draft, setDraft] = useState<OrganizerProfileDraft>(emptyOrganizerProfileDraft);
  const [load, setLoad] = useState<'loading' | 'missing' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    request('/organizer-profiles/me', { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const value = readOrganizerProfile(payload);
        setProfile(value);
        setDraft(organizerProfileDraft(value));
        setLoad('ready');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof Error && 'status' in failure && (failure as { status?: number }).status === 404) setLoad('missing');
        else { setLoad('error'); setError(failure instanceof Error ? failure.message : text.profileValidation); }
      });
    return () => controller.abort();
  }, [allowed, request, text.profileValidation]);

  function field(name: keyof OrganizerProfileDraft) {
    return { name, value: draft[name], onChange: (event: { target: { value: string } }) =>
      setDraft((current) => ({ ...current, [name]: event.target.value })) };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const body = organizerProfilePayload(draft);
      const payload = await request(profile ? '/organizer-profiles/me' : '/organizer-profiles', {
        method: profile ? 'PATCH' : 'POST',
        body,
      });
      const value = readOrganizerProfile(payload);
      setProfile(value);
      setDraft(organizerProfileDraft(value));
      setLoad('ready');
      setNotice(profile ? text.profile.saved : text.profile.created);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : text.profileValidation);
    } finally {
      setPending(false);
    }
  }

  return (
    <Page eyebrow={text.eyebrow} title={text.profile.title} description={text.profile.description}>
      {!user || !allowed ? <OrganizerGate allowed={allowed} returnTo="/organizer/profile" /> : (
        load === 'loading' ? <p role="status">{text.list.loading}</p> : (
          <div className="content-card">
            {error && <div className="notice notice-error" role="alert"><p>{error}</p></div>}
            {notice && <div className="notice notice-success" role="status"><p>{notice}</p></div>}
            {load === 'error' ? null : (
              <form className="auth-form" onSubmit={submit} noValidate aria-busy={pending}>
                <fieldset disabled={pending}>
                  <label htmlFor="organization-name">{text.profile.organization}</label>
                  <input id="organization-name" {...field('organization_name')} required maxLength={200} />
                  <p className="field-hint">{text.profile.organizationHint}</p>
                  <label htmlFor="organization-description">{text.profile.details}</label>
                  <textarea id="organization-description" {...field('description')} rows={5} maxLength={2000} />
                  <label htmlFor="organization-email">{text.profile.email}</label>
                  <input id="organization-email" type="email" {...field('contact_email')} maxLength={255} />
                  <label htmlFor="organization-phone">{text.profile.phone}</label>
                  <input id="organization-phone" {...field('contact_phone')} maxLength={50} />
                  <label htmlFor="organization-website">{text.profile.website}</label>
                  <input id="organization-website" type="url" {...field('website')} maxLength={255} />
                  <button className="button" type="submit">{pending ? text.profile.saving : profile ? text.profile.save : text.profile.create}</button>
                </fieldset>
              </form>
            )}
          </div>
        )
      )}
      {user && canOrganize(user) && <p><Link className="text-link" to="/organizer">{text.editor.backToList}</Link></p>}
    </Page>
  );
}
