import { useEffect, useState } from 'react';
import { getErrorMessage } from '../api';
import { resendWaitMs } from '../account/model';
import { useT } from '../i18n';
import { useAuth } from '../auth/AuthProvider';

// Kept outside the component so the one-per-minute limit survives navigation between pages.
const lastSent = new Map<number, number>();

/** Reminder for a signed-in account whose email is not verified yet. Not shown when the API omits the flag. */
export function VerifyEmailBanner() {
  const text = useT().account;
  const auth = useAuth();
  const user = auth.user?.email_verified === false ? auth.user : null;
  const userId = user?.id ?? null;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait(userId === null ? 0 : resendWaitMs(lastSent.get(userId) ?? null, Date.now())), wait);
    return () => window.clearTimeout(timer);
  }, [wait, userId]);

  if (!user) return null;
  const { id } = user;
  const waiting = wait > 0 || resendWaitMs(lastSent.get(id) ?? null, Date.now()) > 0;

  async function resend() {
    if (sending || resendWaitMs(lastSent.get(id) ?? null, Date.now()) > 0) return;
    setSending(true);
    setError(null);
    // The limit starts with the attempt, so a failed or slow request cannot be repeated at once either.
    lastSent.set(id, Date.now());
    try {
      await auth.request<void>('/auth/resend-verification', { method: 'POST' });
    } catch (failure) {
      if (!(failure instanceof Error && failure.name === 'AbortError')) setError(failure);
    } finally {
      setSending(false);
      setWait(resendWaitMs(lastSent.get(id) ?? null, Date.now()));
    }
  }

  return (
    <section className="notice session-notice" aria-label={text.banner.label}>
      <p>{text.banner.text(user.email)}</p>
      <button className="text-button" type="button" disabled={sending || waiting} onClick={() => { void resend(); }}>
        {sending ? text.banner.sending : text.banner.resend}
      </button>
      {error !== null ? <p role="alert">{getErrorMessage(error)}</p>
        : waiting && !sending && <p aria-live="polite">{text.banner.sent}</p>}
    </section>
  );
}
