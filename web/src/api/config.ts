/** VITE_* values are public. Never include the supplied value in an error. */
export function apiBaseUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error('missing');
  const url = new URL(value.trim());
  const base = url.href;
  // URL.search/hash are empty for a bare ?/#, but href still contains the delimiter.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || base.includes('?') || base.includes('#')) {
    throw new Error('invalid');
  }
  return base.replace(/\/+$/, '');
}
