import { ApiError, type UndoReceipt } from './api.ts';
import { uncertain } from './scanner.ts';

export type UndoResult =
  | { receipt: UndoReceipt; error?: never }
  | { error: ApiError; receipt?: never };

// An undo whose outcome the app does not know yet. It belongs to the account that started it.
export type PendingUndo = {
  userId: number;
  eventId: number;
  checkInId: number;
  requestId: string;
  label: string;
  busy: boolean;
  lastError: ApiError | null;
  // The token the server answered 401 to. A different token means the account has signed in again.
  expiredToken: string | null;
};

type Account = { token: string; userId: number };

const key = (userId: number, eventId: number, checkInId: number) => `${userId}:${eventId}:${checkInId}`;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

// Keeps every undo request outside the screens, so its request ID survives a lost response, a 401,
// the sign-in screen and a remounted scanner. Until the server gives a definite answer, a repeat for the
// same account, event and check-in sends the same request ID with whatever token the account holds then.
// Another account never reuses that ID: it gets its own request.
export function createUndoStore(
  send: (token: string, eventId: number, checkInId: number, requestId: string) => Promise<UndoReceipt>,
  newId: () => string,
) {
  const entries = new Map<string, PendingUndo>();
  const listeners = new Set<() => void>();
  let version = 0;

  function changed() {
    version++;
    for (const listener of [...listeners]) listener();
  }

  return {
    undo(account: Account, eventId: number, checkInId: number, label: string): Promise<UndoResult> | null {
      if (!account.token || !positive(account.userId) || !positive(eventId) || !positive(checkInId)) return null;
      const id = key(account.userId, eventId, checkInId);
      const known = entries.get(id);
      if (known?.busy) return null;
      const entry: PendingUndo = known
        ? { ...known, busy: true, lastError: null, expiredToken: null }
        : {
          userId: account.userId, eventId, checkInId, requestId: newId(), label,
          busy: true, lastError: null, expiredToken: null,
        };
      entries.set(id, entry);
      changed();

      return send(account.token, eventId, checkInId, entry.requestId).then(
        (receipt): UndoResult => { entries.delete(id); return { receipt }; },
        (problem): UndoResult => {
          const error = problem instanceof ApiError
            ? problem
            : new ApiError('SERVER_ERROR', 'The undo could not be confirmed.');
          // Unknown outcome or an expired session: keep the request so it can be repeated unchanged.
          if (uncertain(error) || error.status === 401) {
            entries.set(id, {
              ...entry, busy: false, lastError: error, expiredToken: error.status === 401 ? account.token : null,
            });
          } else entries.delete(id);
          return { error };
        },
      ).finally(changed);
    },
    find(userId: number, eventId: number, checkInId: number): PendingUndo | undefined {
      return entries.get(key(userId, eventId, checkInId));
    },
    // This account's undo requests, optionally for one event. Other accounts' requests are never listed.
    pending(userId: number, eventId?: number): PendingUndo[] {
      return [...entries.values()].filter(entry => entry.userId === userId
        && (eventId === undefined || entry.eventId === eventId));
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => version,
  };
}

export type UndoStore = ReturnType<typeof createUndoStore>;
