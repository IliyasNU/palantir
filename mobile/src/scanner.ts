import { ApiError, type Receipt, type ScanRequest } from './api.ts';

export type ScanResult =
  | { receipt: Receipt; error?: never }
  | { error: ApiError; receipt?: never };

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
      const uncertain = ['NETWORK_ERROR', 'SERVER_ERROR'].includes(error.code)
        || (error.status !== undefined && error.status >= 500);
      // После неизвестного результата даже 401/403 не доказывают,
      // что предыдущая попытка не успела записаться в БД.
      if (uncertain) unresolved = true;
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
    requestId(): string | null {
      return pending?.request_id ?? null;
    },
  };
}
