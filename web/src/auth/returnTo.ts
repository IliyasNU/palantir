/** Only existing public event routes are allowed as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value === value.trim() && /^\/events(?:\/[1-9]\d*)?\/?$/.test(value)
    ? value : '/events';
}

export function authLink(page: '/login' | '/register', returnTo: unknown): string {
  return `${page}?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}
