import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { createAuthStore } from './store';

const AuthContext = createContext<ReturnType<typeof createAuthStore> | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createAuthStore(api));
  return <AuthContext.Provider value={store}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const store = useContext(AuthContext);
  if (!store) throw new Error('useAuth must be used inside AuthProvider');
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...state, login: store.login, register: store.register, logout: store.logout,
    request: store.request, dismissNotice: store.dismissNotice };
}
