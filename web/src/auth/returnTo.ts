/** Only known event, ticket and organizer routes are allowed after login. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value === value.trim()
    && /^(?:\/(?:events|tickets)(?:\/[1-9]\d*)?\/?|\/organizer(?:\/events\/(?:new|[1-9]\d*\/(?:ticket-types|edit)))?\/?)$/.test(value)
    ? value : '/events';
}

export function authLink(page: '/login' | '/register', returnTo: unknown): string {
  return `${page}?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}
