import { ApiError, type StaffSession } from './api.ts';
import { uncertain } from './scanner.ts';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Expiry of a JWT access token (its `exp` claim) as epoch milliseconds. Null when it cannot be read.
// This only schedules a renewal: the server alone decides whether a token is valid.
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  let text = '';
  let bits = 0;
  let value = 0;
  for (const letter of part.replace(/=+$/, '')) {
    const index = BASE64URL.indexOf(letter === '+' ? '-' : letter === '/' ? '_' : letter);
    if (index < 0) return null;
    value = ((value << 6) | index) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      text += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  try {
    const claims: unknown = JSON.parse(text);
    const exp = typeof claims === 'object' && claims !== null ? (claims as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// When to renew a token that was received at `receivedAt` and expires at `expiry`: two minutes ahead, or
// halfway through a shorter life. Null when the phone's clock already puts the expiry in the past or a few
// seconds away: a wrong clock must not turn into a renewal loop, and the next 401 renews instead.
export function renewalTime(expiry: number, receivedAt: number): number | null {
  const life = expiry - receivedAt;
  if (!Number.isFinite(life) || life < 10_000) return null;
  return expiry - Math.min(120_000, life / 2);
}

export type Renewal =
  | { session: StaffSession }
  // The server refused the refresh token or the account: only a password sign-in can continue.
  | { rejected: true }
  // No definite answer (no network, server error): the same refresh token can be tried again.
  | { unavailable: ApiError };

// Renews a session with its refresh token. Parallel calls for the same session share one request, so the
// scanner, the totals and the timer never spend the refresh token twice at once.
export function createRenewer(refresh: (refreshToken: string, userId: number) => Promise<StaffSession>) {
  let running: { key: string; promise: Promise<Renewal> } | null = null;

  return function renew(current: StaffSession | null): Promise<Renewal> {
    if (!current?.refreshToken) return Promise.resolve({ rejected: true });
    const key = `${current.userId}:${current.refreshToken}`;
    if (running?.key === key) return running.promise;
    const promise: Promise<Renewal> = refresh(current.refreshToken, current.userId).then(
      (session): Renewal => (session.userId === current.userId ? { session } : { rejected: true }),
      (problem): Renewal => {
        const error = problem instanceof ApiError ? problem : new ApiError('SERVER_ERROR', 'The session could not be renewed.');
        return uncertain(error) ? { unavailable: error } : { rejected: true };
      },
    ).finally(() => { if (running?.promise === promise) running = null; });
    running = { key, promise };
    return promise;
  };
}
