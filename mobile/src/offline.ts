import { ApiError } from './api.ts';

// Bonus 15 (demo grade): scans made without a connection wait in a queue and are sent together later.
// Each scan gets its own id on the device; the server uses it as the check-in's request id, so a batch can be
// sent again after a lost answer without admitting anyone twice. The first valid scan to reach the server wins.
// The queue lives in memory: it survives leaving the screen, not closing the app.

export type QueuedScan = { client_scan_id: string; qr_payload: string; scanned_at: string };
export type SyncItem = {
  client_scan_id: string;
  result: 'accepted' | 'conflict' | 'rejected';
  code?: string;
  ticket_id?: number;
  checked_in_at?: string;
  conflict?: { checked_in_at: string; staff_name: string };
};
export type SyncProblem = { qr_payload: string; scanned_at: string; code: string; conflict?: SyncItem['conflict'] };
export type SyncOutcome = { accepted: number; conflicts: SyncProblem[]; rejected: SyncProblem[]; error?: ApiError };
export type AddResult = 'queued' | 'duplicate' | 'full' | 'invalid';

export const BATCH = 100; // the server's limit for one call
export const QUEUE_LIMIT = 500;

export function createOfflineQueue(newId: () => string, now: () => Date = () => new Date()) {
  let queue: QueuedScan[] = [];
  let syncing = false;

  return {
    add(payload: string): AddResult {
      if (!payload || payload.length > 512) return 'invalid';
      if (queue.some(scan => scan.qr_payload === payload)) return 'duplicate';
      if (queue.length >= QUEUE_LIMIT) return 'full';
      queue.push({ client_scan_id: newId(), qr_payload: payload, scanned_at: now().toISOString() });
      return 'queued';
    },
    size(): number { return queue.length; },
    items(): readonly QueuedScan[] { return queue; },
    busy(): boolean { return syncing; },
    // Sends the queue in the order scanned. A scan leaves the queue only when the server answered for it;
    // after a failure the rest stays queued with the same ids, so the next attempt is a safe repeat.
    async sync(send: (scans: QueuedScan[]) => Promise<SyncItem[]>): Promise<SyncOutcome | null> {
      if (syncing) return null;
      syncing = true;
      const outcome: SyncOutcome = { accepted: 0, conflicts: [], rejected: [] };
      try {
        while (queue.length) {
          const batch = queue.slice(0, BATCH);
          const results = await send(batch);
          const answered = new Map(results.map(item => [item.client_scan_id, item]));
          for (const scan of batch) {
            const item = answered.get(scan.client_scan_id);
            if (!item) throw new ApiError('SERVER_ERROR', 'The server did not answer for every scan.');
            if (item.result === 'accepted') outcome.accepted += 1;
            else {
              const problem = { qr_payload: scan.qr_payload, scanned_at: scan.scanned_at, code: item.code ?? 'REQUEST_ERROR',
                ...(item.conflict ? { conflict: item.conflict } : {}) };
              (item.result === 'conflict' ? outcome.conflicts : outcome.rejected).push(problem);
            }
          }
          const sent = new Set(batch.map(scan => scan.client_scan_id));
          queue = queue.filter(scan => !sent.has(scan.client_scan_id));
        }
      } catch (problem) {
        outcome.error = problem instanceof ApiError ? problem : new ApiError('SERVER_ERROR', 'The sync could not be confirmed.');
      } finally {
        syncing = false;
      }
      return outcome;
    },
  };
}

export type OfflineQueue = ReturnType<typeof createOfflineQueue>;

const queues = new Map<string, OfflineQueue>();

// One queue per staff account and event for as long as the app runs, so leaving the screen loses nothing.
export function queueFor(userId: number, eventId: number, newId: () => string): OfflineQueue {
  const key = `${userId}:${eventId}`;
  let queue = queues.get(key);
  if (!queue) { queue = createOfflineQueue(newId); queues.set(key, queue); }
  return queue;
}
