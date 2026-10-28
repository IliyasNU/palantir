import { useEffect, useRef, useState } from 'react';

export function useSubmission() {
  const inFlight = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => () => { inFlight.current?.abort(); }, []);

  async function submit(work: (signal: AbortSignal) => Promise<void>) {
    // Ref guards the gap before React renders the disabled button.
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    setError(null);
    try {
      await work(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted && !(failure instanceof Error && failure.name === 'AbortError')) setError(failure);
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  return { pending, error, submit };
}
