import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import type { StaffSession } from './api';

const SessionContext = createContext<{
  session: StaffSession | null;
  setSession: (value: StaffSession | null) => void;
}>({ session: null, setSession: () => {} });

export function SessionProvider({ children }: PropsWithChildren) {
  // Keep this first version simple: log in again after closing the app or token expiry.
  const [session, setSession] = useState<StaffSession | null>(null);
  return <SessionContext.Provider value={{ session, setSession }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

