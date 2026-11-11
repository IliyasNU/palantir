/** Only known event and ticket routes are allowed as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value === value.trim() && /^\/(?:events|tickets|organizer)(?:\/[1-9]\d*)?\/?$/.test(value)
    ? value : '/events';
}

export function authLink(page: '/login' | '/register', returnTo: unknown): string {
  return `${page}?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}
