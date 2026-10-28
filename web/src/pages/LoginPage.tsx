import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { FormEvent } from 'react';
import { Page } from '../components/Page';
import { AuthFormError } from '../components/AuthFormError';
import { useAuth } from '../auth/AuthProvider';
import { authLink, safeReturnTo } from '../auth/returnTo';
import { useSubmission } from '../auth/useSubmission';

export function LoginPage() {
  const auth = useAuth();
  const { pending, error, submit } = useSubmission();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(params.get('returnTo'));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void submit(async (signal) => {
      try {
        await auth.login({ email: String(data.get('email') ?? ''), password: String(data.get('password') ?? '') }, signal);
        if (!signal.aborted) navigate(returnTo, { replace: true });
      } finally {
        const password = form.elements.namedItem('password');
        if (password instanceof HTMLInputElement) password.value = '';
        data.delete('password');
      }
    });
  }
  return (
    <Page
      eyebrow="Ваш аккаунт"
      title="Вход в BiletFlow"
      description="Рады видеть вас снова."
    >
      <div className="content-card narrow-card">
        {auth.user ? (
          <><p>Вы уже вошли как {auth.user.full_name}.</p><Link className="button" to={returnTo}>Продолжить</Link></>
        ) : (
          <>
            {location.state?.registered === true && <div className="notice notice-success" role="status">Аккаунт создан. Войдите с вашим email и паролем.</div>}
            <form className="auth-form" onSubmit={onSubmit} aria-busy={pending} aria-describedby={error ? 'form-error' : undefined}>
              <AuthFormError error={error} mode="login" />
              <fieldset disabled={pending}>
                <label htmlFor="login-email">Email</label>
                <input id="login-email" name="email" type="email" autoComplete="username" required />
                <label htmlFor="login-password">Пароль</label>
                <input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
                <button className="button" type="submit" disabled={pending}>{pending ? 'Входим…' : 'Войти'}</button>
              </fieldset>
            </form>
            <p>Нет аккаунта? <Link className="text-link" to={authLink('/register', returnTo)}>Зарегистрироваться</Link></p>
          </>
        )}
      </div>
    </Page>
  );
}
