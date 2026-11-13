import { Link, useNavigate, useSearchParams } from 'react-router';
import type { FormEvent } from 'react';
import { Page } from '../components/Page';
import { AuthFormError } from '../components/AuthFormError';
import { useAuth } from '../auth/AuthProvider';
import { authLink, safeReturnTo } from '../auth/returnTo';
import { validateRegistration } from '../auth/formErrors';
import { useSubmission } from '../auth/useSubmission';
import { useT } from '../i18n';

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
        const input = { email: String(data.get('email') ?? ''), full_name: String(data.get('full_name') ?? ''), password: String(data.get('password') ?? '') };
        validateRegistration(input);
        await auth.register(input, signal);
        if (!signal.aborted) navigate(authLink('/login', returnTo), { replace: true, state: { registered: true } });
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
