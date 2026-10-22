import { createContext, useContext, useState, type PropsWithChildren } from 'react';

const SessionContext = createContext<{
  token: string | null;
  setToken: (value: string | null) => void;
}>({ token: null, setToken: () => {} });

export function SessionProvider({ children }: PropsWithChildren) {
  // Keep this first version simple: log in again after closing the app or token expiry.
  const [token, setToken] = useState<string | null>(null);
  return <SessionContext.Provider value={{ token, setToken }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
