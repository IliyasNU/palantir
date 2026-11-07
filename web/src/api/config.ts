/** VITE_* values are public. Never include the supplied value in an error. */
export function apiBaseUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error('missing');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid');
  }
  return url.toString().replace(/\/+$/, '');
}
