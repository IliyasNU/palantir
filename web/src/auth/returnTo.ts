/** Only known event, ticket, order and organizer routes are allowed after login. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()) return '/events';

  if (/^\/(?:events|tickets|orders)(?:\/[1-9]\d*)?\/?$/.test(value)) return value;
  if (/^\/events\/[1-9]\d*\?campaign=pc_[0-9a-f]{32}$/.test(value)) return value;
  if (/^\/events\/[1-9]\d*\/checkout\?type=[1-9]\d*(?:&campaign=pc_[0-9a-f]{32})?$/.test(value)) return value;
  if (/^\/organizer\/?$/.test(value)) return value;
  if (/^\/organizer\/profile\/?$/.test(value)) return value;
  if (/^\/organizer\/events\/(?:new|[1-9]\d*\/(?:ticket-types|activation|campaigns|edit))\/?$/.test(value)) return value;
  return '/events';
}

export function authLink(page: '/login' | '/register', returnTo: unknown): string {
  return `${page}?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}
