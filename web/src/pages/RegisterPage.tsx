import { Link, useNavigate, useSearchParams } from 'react-router';
import type { FormEvent } from 'react';
import { Page } from '../components/Page';
import { AuthFormError } from '../components/AuthFormError';
import { useAuth } from '../auth/AuthProvider';
import { authLink, safeReturnTo } from '../auth/returnTo';
import { validateRegistration } from '../auth/formErrors';
import { useSubmission } from '../auth/useSubmission';
import { useT } from '../i18n';
import { isRegistrationRole } from '../auth/types';

export function RegisterPage() {
  const auth = useAuth();
  const t = useT();
  const { pending, error, submit } = useSubmission();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(params.get('returnTo'));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void submit(async (signal) => {
      try {
        const chosen = data.get('role');
        const role = isRegistrationRole(chosen) ? chosen : 'attendee';
        const input = { email: String(data.get('email') ?? ''), full_name: String(data.get('full_name') ?? ''), password: String(data.get('password') ?? ''), role };
        validateRegistration(input);
        const user = await auth.register(input, signal);
        // A new organizer goes on to the cabinet after signing in, unless a page asked to come back to it.
        const next = user.role === 'organizer' && returnTo === '/events' ? '/organizer' : returnTo;
        if (!signal.aborted) navigate(authLink('/login', next), { replace: true, state: { registered: true, role: user.role } });
      } finally {
        const password = form.elements.namedItem('password');
        if (password instanceof HTMLInputElement) password.value = '';
        data.delete('password');
      }
    });
  }
  return (
    <Page
      eyebrow={t.auth.registerEyebrow}
      title={t.auth.registerTitle}
      description={t.auth.registerDescription}
    >
      <div className="content-card narrow-card">
        {auth.user ? (
          <><p>{t.auth.alreadyIn(auth.user.full_name)}</p><Link className="button" to={returnTo}>{t.auth.proceed}</Link></>
        ) : (
          <>
            <form className="auth-form" onSubmit={onSubmit} aria-busy={pending} aria-describedby={error ? 'form-error' : undefined}>
              <AuthFormError error={error} mode="register" />
              <fieldset disabled={pending}>
                <label htmlFor="register-name">{t.auth.name}</label>
                <input id="register-name" name="full_name" autoComplete="name" required maxLength={255} />
                <label htmlFor="register-email">{t.auth.email}</label>
                <input id="register-email" name="email" type="email" autoComplete="username" required />
                <label htmlFor="register-password">{t.auth.password}</label>
                <input id="register-password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} aria-describedby="password-hint" />
                <p className="field-hint" id="password-hint">{t.auth.passwordHint}</p>
                <fieldset className="role-choice">
                  <legend>{t.auth.roleLegend}</legend>
                  {(['attendee', 'organizer'] as const).map((role) => (
                    <div className="role-option" key={role}>
                      <input id={`role-${role}`} type="radio" name="role" value={role} defaultChecked={role === 'attendee'}
                        aria-describedby={`role-${role}-hint`} />
                      <label htmlFor={`role-${role}`}>{role === 'attendee' ? t.auth.roleAttendee : t.auth.roleOrganizer}</label>
                      <p className="field-hint" id={`role-${role}-hint`}>{role === 'attendee' ? t.auth.roleAttendeeHint : t.auth.roleOrganizerHint}</p>
                    </div>
                  ))}
                </fieldset>
                <button className="button" type="submit" disabled={pending}>{pending ? t.auth.registerPending : t.auth.registerSubmit}</button>
              </fieldset>
            </form>
            <p>{t.auth.haveAccount} <Link className="text-link" to={authLink('/login', returnTo)}>{t.auth.toLogin}</Link></p>
          </>
        )}
      </div>
    </Page>
  );
}
