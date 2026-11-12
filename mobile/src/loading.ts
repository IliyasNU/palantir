// State of a value that is reloaded on demand, e.g. the attendance totals.
// `request` names the reload the state belongs to, so a view can tell "still loading" from "settled".
export type Load<T> = { request: string; data: T | null; at: number | null; error: unknown };

export function emptyLoad<T>(): Load<T> {
  return { request: '', data: null, at: null, error: null };
}

export function loadSucceeded<T>(request: string, data: T, at: number): Load<T> {
  return { request, data, at, error: null };
}

// A failed reload keeps the last good value and its time: the screen shows it as outdated, not as current.
export function loadFailed<T>(previous: Load<T>, request: string, error: unknown): Load<T> {
  return { ...previous, request, error: error ?? new Error('unknown') };
}

export function loadView<T>(load: Load<T>, request: string) {
  const loading = load.request !== request;
  return { loading, failed: !loading && load.error !== null, empty: load.data === null };
}
