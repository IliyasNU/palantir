import { useEffect, useState } from 'react';
import type { api } from '../api';
import { readQuote, type Quote } from './model';

export function usePromoQuote(request: typeof api.request, eventId: number | null, typeId: number | null,
                             ref: string, byToken: boolean) {
  const key = JSON.stringify([eventId, typeId, ref, byToken]);
  const [state, setState] = useState<{key: string; quote: Quote} | {key: string; error: unknown} | null>(null);
  useEffect(() => {
    if (!ref || eventId === null) return;
    const controller = new AbortController();
    request(`/events/${eventId}/campaigns/quote`, {method: 'POST', signal: controller.signal,
      body: {...(byToken ? {token: ref} : {code: ref}), ticket_type_id: typeId}})
      .then(v => readQuote(v, typeId))
      .then(quote => { if (!controller.signal.aborted) setState({key, quote}); })
      .catch((e: unknown) => { if (!controller.signal.aborted) setState({key, error: e}); });
    return () => controller.abort();
  }, [key, request, eventId, typeId, ref, byToken]);
  return ref && state?.key === key ? state : null;
}
