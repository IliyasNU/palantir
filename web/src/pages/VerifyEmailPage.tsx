import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { isInvalidLink, linkErrorMessage } from '../account/model';
import { accountText as text } from '../account/strings';
import { useAuth } from '../auth/AuthProvider';
import { Page } from '../components/Page';

type State = { step: 'checking' } | { step: 'verified' } | { step: 'failed'; error: unknown };

export function VerifyEmailPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ step: 'checking' });
  // One request per link and attempt, also when React runs the effect twice in development.
  const started = useRef('');
  const { markEmailVerified } = auth;

  useEffect(() => {
    const key = `${attempt}:${token}`;
    if (!token || started.current === key) return;
    started.current = key;
    api.request('/auth/verify-email', { method: 'POST', body: { token } }).then((user) => {
      if (started.current !== key) return;
      if (typeof user === 'object' && user !== null && 'id' in user && typeof user.id === 'number') markEmailVerified(user.id);
      setState({ step: 'verified' });
    }, (error: unknown) => {
      if (started.current === key) setState({ step: 'failed', error });
    });
  }, [token, attempt, markEmailVerified]);

  const invalid = !token || (state.step === 'failed' && isInvalidLink(state.error));
  return (
    <Page eyebrow={text.eyebrow} title={text.verify.title} description={text.verify.description}>
      <div className="content-card narrow-card">
        {invalid ? (
          <>
            <div className="notice notice-error" role="alert"><p>{text.invalidLink}</p><p>{text.verify.invalidHint}</p></div>
            <Link className="button" to={auth.user ? '/events' : '/login'}>{auth.user ? text.toEvents : text.toLogin}</Link>
          </>
        ) : state.step === 'failed' ? (
          <>
            <div className="notice notice-error" role="alert"><p>{linkErrorMessage(state.error)}</p></div>
            <button className="button" type="button" onClick={() => { setState({ step: 'checking' }); setAttempt((value) => value + 1); }}>
              {text.verify.retry}
            </button>
          </>
        ) : state.step === 'verified' ? (
          <>
            <div className="notice notice-success" role="status"><p>{text.verify.success}</p></div>
            <Link className="button" to={auth.user ? '/events' : '/login'}>{auth.user ? text.toEvents : text.toLogin}</Link>
          </>
        ) : <p role="status">{text.verify.checking}</p>}
      </div>
    </Page>
  );
}
