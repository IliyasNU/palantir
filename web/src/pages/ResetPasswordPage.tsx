import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { isInvalidLink, linkErrorMessage, validateNewPassword } from '../account/model';
import { accountText as text } from '../account/strings';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { pending, error, submit } = useSubmission();
  const [done, setDone] = useState(false);
  const invalid = !token || isInvalidLink(error);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem('new_password');
    if (!(field instanceof HTMLInputElement)) return;
    void submit(async (signal) => {
      try {
        validateNewPassword(field.value);
        await api.request<void>('/auth/reset-password', { method: 'POST', body: { token, new_password: field.value }, signal });
        if (!signal.aborted) setDone(true);
      } finally {
        field.value = '';
      }
    });
  }

  return (
    <Page eyebrow={text.eyebrow} title={text.reset.title} description={text.reset.description}>
      <div className="content-card narrow-card">
        {done ? (
          <>
            <div className="notice notice-success" role="status"><p>{text.reset.success}</p></div>
            <Link className="button" to="/login">{text.toLogin}</Link>
          </>
        ) : invalid ? (
          <>
            <div className="notice notice-error" role="alert"><p>{text.invalidLink}</p><p>{text.reset.invalidHint}</p></div>
            <Link className="button" to="/forgot-password">{text.reset.requestAgain}</Link>
          </>
        ) : (
          <form className="auth-form" onSubmit={onSubmit} aria-busy={pending} aria-describedby={error ? 'form-error' : undefined}>
            {error !== null && (
              <div className="notice notice-error" role="alert" id="form-error">
                <p>{linkErrorMessage(error)}</p>
                {error instanceof ApiError && error.issues.length > 0 && (
                  <ul>{error.issues.map((issue, index) => <li key={`${issue.field}-${index}`}>{issue.message}</li>)}</ul>
                )}
              </div>
            )}
            <fieldset disabled={pending}>
              <label htmlFor="reset-password">{text.reset.password}</label>
              <input id="reset-password" name="new_password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} aria-describedby="reset-password-hint" />
              <p className="field-hint" id="reset-password-hint">{text.reset.passwordHint}</p>
              <button className="button" type="submit" disabled={pending}>{pending ? text.reset.submitting : text.reset.submit}</button>
            </fieldset>
          </form>
        )}
      </div>
    </Page>
  );
}
