import { ApiError, type Receipt, type ScanRequest } from './api.ts';

export type ScanResult = { receipt: Receipt; error?: never } | { error: ApiError; receipt?: never };

// Camera callbacks can arrive before React updates the screen. Lock synchronously.
export function createScanner(send: (request: ScanRequest) => Promise<Receipt>, newId: () => string) {
  let pending: ScanRequest | null = null;
  let busy = false;

  async function submit(): Promise<ScanResult> {
    busy = true;
    try {
      return { receipt: await send(pending!) };
    } catch (error) {
      return { error: error instanceof ApiError ? error : new ApiError('SERVER_ERROR', 'Check-in could not be confirmed.') };
    } finally {
      busy = false;
    }
  }

  return {
    scan(payload: string): Promise<ScanResult> | null {
      if (pending || busy) return null;
      pending = { qr_payload: payload, request_id: newId() };
      return submit();
    },
    retry(): Promise<ScanResult> | null {
      // If the first response was lost, retry the SAME request, not a new admission.
      return pending && !busy ? submit() : null;
    },
    next() {
      if (!busy) pending = null;
    },
  };
}
