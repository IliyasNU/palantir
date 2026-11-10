import { ApiError, type Receipt, type ScanRequest, type UndoReceipt } from './api.ts';

export type ScanResult =
  | { receipt: Receipt; error?: never }
  | { error: ApiError; receipt?: never };

export type UndoResult =
  | { receipt: UndoReceipt; error?: never }
  | { error: ApiError; receipt?: never };

function uncertain(error: ApiError): boolean {
  return ['NETWORK_ERROR', 'SERVER_ERROR'].includes(error.code) || (error.status !== undefined && error.status >= 500);
}

// The server names this exact request (CHECK_IN_UNDONE) or a final ticket state. Either way no admission
// from this request is or can become current, so an earlier uncertain attempt is settled as not admitted.
const SETTLED = ['CHECK_IN_UNDONE', 'TICKET_CANCELLED', 'TICKET_REFUNDED'];

export function createScanSession(send: (token: string, request: ScanRequest) => Promise<Receipt>, newId: () => string) {
  let token = '';
  return {
    scanner: createScanner(request => send(token, request), newId),
    setToken(value: string) { token = value; },
  };
}

export function createScanner(
  send: (request: ScanRequest) => Promise<Receipt>,
  newId: () => string,
) {
  let pending: ScanRequest | null = null;
  let busy = false;
  let unresolved = false;

  async function submit(): Promise<ScanResult> {
    busy = true;
    try {
      const receipt = await send(pending!);
      unresolved = false;
      return { receipt };
    } catch (problem) {
      const error = problem instanceof ApiError
        ? problem
        : new ApiError('SERVER_ERROR', 'Check-in could not be confirmed.');
      // После неизвестного результата даже 401/403 не доказывают,
      // что предыдущая попытка не успела записаться в БД.
      if (uncertain(error)) unresolved = true;
      else if (error.status === 409 && SETTLED.includes(error.code)) unresolved = false;
      return { error };
    } finally {
      busy = false;
    }
  }

  return {
    scan(payload: string): Promise<ScanResult> | null {
      if (!payload || pending || busy) return null;
      pending = { qr_payload: payload, request_id: newId() };
      return submit();
    },
    retry(): Promise<ScanResult> | null {
      return pending && !busy ? submit() : null;
    },
    next(): boolean {
      if (busy || unresolved) return false;
      pending = null;
      return true;
    },
    mustResolve(): boolean {
      return busy || unresolved;
    },
    canHandOff(requestId: string): boolean {
      return unresolved && !busy && pending?.request_id === requestId;
    },
    requestId(): string | null {
      return pending?.request_id ?? null;
    },
  };
}

export function createUndoSession(
  send: (token: string, checkInId: number, requestId: string) => Promise<UndoReceipt>,
  newId: () => string,
) {
  let token = '';
  return {
    ...createUndo((checkInId, requestId) => send(token, checkInId, requestId), newId),
    setToken(value: string) { token = value; },
  };
}

// One undo at a time. A repeat for the same check-in reuses its request ID until the server gives a
// definite answer, so a lost response can be retried without a second reversal.
export function createUndo(
  send: (checkInId: number, requestId: string) => Promise<UndoReceipt>,
  newId: () => string,
) {
  let pending: { checkInId: number; requestId: string } | null = null;
  let busy = false;

  return {
    undo(checkInId: number): Promise<UndoResult> | null {
      if (busy || !Number.isSafeInteger(checkInId) || checkInId < 1) return null;
      if (pending?.checkInId !== checkInId) pending = { checkInId, requestId: newId() };
      const { requestId } = pending;
      busy = true;
      return send(checkInId, requestId).then(
        (receipt): UndoResult => { pending = null; return { receipt }; },
        (problem): UndoResult => {
          const error = problem instanceof ApiError
            ? problem
            : new ApiError('SERVER_ERROR', 'The undo could not be confirmed.');
          // Keep the ID while the outcome is unknown or the session has to be renewed.
          if (!uncertain(error) && error.status !== 401) pending = null;
          return { error };
        },
      ).finally(() => { busy = false; });
    },
    unconfirmed(checkInId: number): boolean {
      return !busy && pending?.checkInId === checkInId;
    },
    requestId(): string | null {
      return pending?.requestId ?? null;
    },
  };
}
