import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { api, getErrorMessage } from '../api';
import { forgotPasswordAnswered } from '../account/model';
import { accountText as text } from '../account/strings';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';

export function ForgotPasswordPage() {
  const { pending, error, submit } = useSubmission();
  const [sent, setSent] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    void submit(async (signal) => {
      try {
        await api.request<void>('/auth/forgot-password', { method: 'POST', body: { email }, signal });
      } catch (failure) {
        // Whatever the server answers, the page says the same thing: it never shows whether the address exists.
        if (!forgotPasswordAnswered(failure)) throw failure;
      }
      if (!signal.aborted) setSent(true);
    });
  }

  return (
    <Page eyebrow={text.eyebrow} title={text.forgot.title} description={text.forgot.description}>
      <div className="content-card narrow-card">
        {sent ? (
          <div className="notice notice-success" role="status"><p>{text.forgot.sent}</p></div>
        ) : (
          <form className="auth-form" onSubmit={onSubmit} aria-busy={pending} aria-describedby={error ? 'form-error' : undefined}>
            {error !== null && <div className="notice notice-error" role="alert" id="form-error"><p>{getErrorMessage(error)}</p></div>}
            <fieldset disabled={pending}>
              <label htmlFor="forgot-email">{text.forgot.email}</label>
              <input id="forgot-email" name="email" type="email" autoComplete="username" required />
              <button className="button" type="submit" disabled={pending}>{pending ? text.forgot.submitting : text.forgot.submit}</button>
            </fieldset>
          </form>
        )}
        <p><Link className="text-link" to="/login">{text.toLogin}</Link></p>
      </div>
    </Page>
  );
}
