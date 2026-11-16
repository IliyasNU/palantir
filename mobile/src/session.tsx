import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { api, type StaffSession } from './api';
import { createRenewer, renewalTime, tokenExpiry } from './renewal';

// A renewed session for the same account, or why there is none: `rejected` needs a password sign-in,
// `unavailable` had no definite answer and may be tried again.
export type RenewResult = StaffSession | 'rejected' | 'unavailable';

const SessionContext = createContext<{
  session: StaffSession | null;
  setSession: (value: StaffSession | null) => void;
  renew: () => Promise<RenewResult>;
}>({ session: null, setSession: () => {}, renew: async () => 'rejected' });

export function SessionProvider({ children }: PropsWithChildren) {
  // The session lives in memory only: after closing the app, sign in again.
  const [session, setState] = useState<StaffSession | null>(null);
  const current = useRef<StaffSession | null>(null);
  const renewer = useMemo(() => createRenewer((refreshToken, userId) => api.refresh(refreshToken, userId)), []);

  const setSession = useCallback((value: StaffSession | null) => {
    current.current = value;
    setState(value);
  }, []);

  const renew = useCallback(async (): Promise<RenewResult> => {
    const before = current.current;
    const result = await renewer(before);
    if ('unavailable' in result) return 'unavailable';
    // Signed out or another account signed in while the request was running: its answer no longer applies.
    if ('rejected' in result || current.current?.userId !== before?.userId) return 'rejected';
    // A parallel caller already stored this renewal.
    if (current.current?.token !== before?.token) return current.current!;
    setSession(result.session);
    return result.session;
  }, [renewer, setSession]);

  // Access tokens are short-lived. Renew shortly before the expiry while the app is in front, so a shift at
  // the entrance is not interrupted by a password prompt. A missed renewal is recovered after the next 401.
  useEffect(() => {
    if (!session?.refreshToken) return;
    const expiry = tokenExpiry(session.token);
    const due = expiry === null ? null : renewalTime(expiry, Date.now());
    if (due === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function plan(delay: number) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!live || AppState.currentState !== 'active') return;
        void renew().then(result => { if (live && result === 'unavailable') plan(30_000); });
      }, Math.min(delay, 2_000_000_000));
    }

    plan(Math.max(0, due - Date.now()));
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') plan(Math.max(0, due - Date.now()));
    });
    return () => { live = false; clearTimeout(timer); subscription.remove(); };
  }, [session, renew]);

  const value = useMemo(() => ({ session, setSession, renew }), [session, setSession, renew]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
