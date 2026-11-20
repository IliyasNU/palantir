import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { forgotPasswordError, forgotPasswordOutcome } from '../account/model';
import { authLink, safeReturnTo } from '../auth/returnTo';
import { useT } from '../i18n';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';

export function ForgotPasswordPage() {
  const text = useT().account;
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const { pending, error, submit } = useSubmission();
  const [sent, setSent] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    void submit(async (signal) => {
      try {
        await api.request<void>('/auth/forgot-password', { method: 'POST', body: { email }, signal });
      } catch (failure) {
        // Refusals that could depend on the account look exactly like a success.
        if (forgotPasswordOutcome(failure) !== 'sent') throw failure;
      }
      if (!signal.aborted) setSent(true);
    });
  }
  const outcome = forgotPasswordOutcome(error);

  return (
    <Page eyebrow={text.eyebrow} title={text.forgot.title} description={text.forgot.description}>
      <div className="content-card narrow-card">
        {sent ? (
          <div className="notice notice-success" role="status"><p>{text.forgot.sent}</p></div>
        ) : (
          <form className="auth-form" onSubmit={onSubmit} aria-busy={pending} aria-describedby={outcome !== 'sent' ? 'form-error' : undefined}>
            {outcome !== 'sent' && <div className="notice notice-error" role="alert" id="form-error"><p>{forgotPasswordError(outcome, error)}</p></div>}
            <fieldset disabled={pending}>
              <label htmlFor="forgot-email">{text.forgot.email}</label>
              <input id="forgot-email" name="email" type="email" autoComplete="username" required />
              <button className="button" type="submit" disabled={pending}>{pending ? text.forgot.submitting : text.forgot.submit}</button>
            </fieldset>
          </form>
        )}
        <p><Link className="text-link" to={authLink('/login', returnTo)}>{text.toLogin}</Link></p>
      </div>
    </Page>
  );
}
