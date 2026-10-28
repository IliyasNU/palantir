import { ApiError } from '../api/client.ts';
import type { ApiRequestOptions, createApiClient } from '../api/client.ts';
import type { LoginInput, RegistrationInput, TokenPair, User } from './types.ts';

type ApiClient = ReturnType<typeof createApiClient>;
export interface AuthState {
  user: User | null;
  status: 'anonymous' | 'authenticating' | 'authenticated';
  notice: 'expired' | 'forbidden' | null;
}

function invalidResponse(): ApiError {
  return new ApiError('Не удалось подтвердить данные аккаунта. Попробуйте войти ещё раз.', { kind: 'response' });
}

function readUser(value: unknown): User {
  if (!value || typeof value !== 'object') throw invalidResponse();
  const user = value as Record<string, unknown>;
  if (!Number.isInteger(user.id) || typeof user.email !== 'string' || typeof user.full_name !== 'string'
    || typeof user.role !== 'string' || typeof user.is_active !== 'boolean' || typeof user.created_at !== 'string') {
    throw invalidResponse();
  }
  // Keep only the known public fields, never an arbitrary response object.
  return {
    id: user.id as number, email: user.email, full_name: user.full_name,
    role: user.role, is_active: user.is_active, created_at: user.created_at,
  };
}

export function createAuthStore(api: ApiClient) {
  let state: AuthState = { user: null, status: 'anonymous', notice: null };
  let accessToken: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const pending = new Set<AbortController>();

  function publish(next: AuthState) {
    state = next;
    listeners.forEach((listener) => listener());
  }

  function clearSession(notice: AuthState['notice'] = null) {
    generation += 1;
    accessToken = null;
    pending.forEach((controller) => controller.abort());
    pending.clear();
    publish({ user: null, status: 'anonymous', notice });
  }

  function ensureCurrent(version: number, signal: AbortSignal) {
    if (version !== generation || signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    logout: () => clearSession(),
    dismissNotice: () => publish({ ...state, notice: null }),

    async register(input: RegistrationInput, signal?: AbortSignal): Promise<User> {
      return readUser(await api.request('/auth/register', {
        method: 'POST',
        body: { email: input.email.trim(), full_name: input.full_name.trim(), password: input.password, role: 'attendee' },
        signal,
      }));
    },

    async login(input: LoginInput, callerSignal?: AbortSignal): Promise<void> {
      if (state.status === 'authenticating') throw new DOMException('Login already pending', 'AbortError');
      clearSession();
      const version = generation;
      const controller = new AbortController();
      const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
      pending.add(controller);
      publish({ user: null, status: 'authenticating', notice: null });
      try {
        const tokens = await api.request<TokenPair>('/auth/login', {
          method: 'POST', body: { email: input.email.trim(), password: input.password }, signal,
        });
        ensureCurrent(version, signal);
        if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.token_type !== 'bearer') {
          throw invalidResponse();
        }
        const user = readUser(await api.request('/auth/me', { token: tokens.access_token, signal }));
        ensureCurrent(version, signal);
        if (!user.is_active) throw new ApiError('Этот аккаунт отключён.', { kind: 'http', status: 403 });
        accessToken = tokens.access_token;
        // refresh_token is deliberately discarded. No persistence and no automatic refresh.
        publish({ user, status: 'authenticated', notice: null });
      } catch (error) {
        if (version === generation) clearSession();
        throw error;
      } finally {
        pending.delete(controller);
      }
    },

    async request<T = unknown>(path: string, options: Omit<ApiRequestOptions, 'token'> = {}): Promise<T> {
      if (!accessToken) {
        clearSession('expired');
        throw new ApiError('Войдите в аккаунт для продолжения.', { kind: 'http', status: 401 });
      }
      const version = generation;
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      pending.add(controller);
      try {
        const result = await api.request<T>(path, { ...options, token: accessToken, signal });
        ensureCurrent(version, signal);
        return result;
      } catch (error) {
        // An old request must neither clear a newer session nor return private data after logout.
        ensureCurrent(version, signal);
        if (error instanceof ApiError && error.status === 401) clearSession('expired');
        if (error instanceof ApiError && error.status === 403) publish({ ...state, notice: 'forbidden' });
        throw error;
      } finally {
        pending.delete(controller);
      }
    },
  };
}
