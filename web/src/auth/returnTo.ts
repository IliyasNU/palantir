/** Only explicitly recognized application routes are allowed after login. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()) return '/events';

  if (/^\/(?:events|tickets|orders)(?:\/[1-9]\d*)?\/?$/.test(value)) return value;
  if (/^\/events\/[1-9]\d*\?campaign=pc_[0-9a-f]{32}$/.test(value)) return value;
  if (/^\/events\/[1-9]\d*\/checkout\?type=[1-9]\d*(?:&campaign=pc_[0-9a-f]{32})?$/.test(value)) return value;
  if (/^\/organizer\/?$/.test(value)) return value;
  if (/^\/organizer\/profile\/?$/.test(value)) return value;
  if (/^\/organizer\/events\/(?:new|[1-9]\d*\/(?:ticket-types|activation|campaigns|edit|history|support))\/?$/.test(value)) return value;
  if (/^\/(?:support(?:\/cases\/[1-9]\d*)?|admin\/support)\/?$/.test(value)) return value;
  if (value === '/support/new?kind=organizer') return value;
  const supportSource = value.match(/^\/support\/new\?(?:event|order|ticket)=([1-9]\d*)$/);
  if (supportSource && Number(supportSource[1]) <= 2_147_483_647) return value;
  return '/events';
}

export function authLink(page: '/login' | '/register', returnTo: unknown): string {
  return `${page}?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}
