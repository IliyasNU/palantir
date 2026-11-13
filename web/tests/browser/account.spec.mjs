import { test, expect } from '@playwright/test';

const base = 'http://localhost:8000';
const user = { id: 7, email: 'fixture@example.com', full_name: 'Account Visitor', role: 'attendee', is_active: true, created_at: '2030-01-01T00:00:00Z' };
const invalidToken = { status: 400, json: { detail: { code: 'INVALID_TOKEN', message: 'The link is invalid or has expired' } } };

// CI runs these tests next to a real API on the same address. Any call a test does not mock must fail here
// instead of reaching that API: a real 401 for the fixture token would end the session in the middle of a test.
test.beforeEach(async ({ page }) => {
  await page.route((url) => url.origin === base, (route) => route.abort('failed'));
});

async function login(page, me) {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', refresh_token: 'unused', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: me }));
  await page.route(`${base}/events`, (route) => route.fulfill({ json: [] }));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(me.email);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('/events');
}
// Client-side navigation: a reload would drop the memory-only session.
const go = (page, path) => page.evaluate((target) => {
  history.pushState(null, '', target);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);

test('a verification link is sent once and reports success, an invalid link or a missing token', async ({ page }) => {
  const bodies = [];
  await page.route(`${base}/auth/verify-email`, (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBeUndefined();
    bodies.push(route.request().postDataJSON());
    return bodies.at(-1).token === 'good-token' ? route.fulfill({ json: { ...user, email_verified: true } }) : route.fulfill(invalidToken);
  });
  await page.goto('/verify-email?token=good-token');
  await expect(page.getByRole('status')).toHaveText('Email подтверждён. Спасибо!');
  await expect(page.getByRole('link', { name: 'Перейти ко входу' })).toHaveAttribute('href', '/login');
  await page.goto('/verify-email?token=used-token');
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна');
  expect(bodies).toEqual([{ token: 'good-token' }, { token: 'used-token' }]);
  await page.goto('/verify-email');
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна');
  expect(bodies).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a failed connection during verification is not called an invalid link and can be retried', async ({ page }) => {
  let attempts = 0;
  await page.route(`${base}/auth/verify-email`, (route) => (++attempts === 1 ? route.abort('failed') : route.fulfill({ json: user })));
  await page.goto('/verify-email?token=good-token');
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByRole('alert')).not.toContainText('Ссылка недействительна');
  await page.getByRole('button', { name: 'Повторить проверку' }).click();
  await expect(page.getByRole('status')).toHaveText('Email подтверждён. Спасибо!');
  expect(attempts).toBe(2);
});

test('password reset validates locally, sends token and new_password, and handles 204 and INVALID_TOKEN', async ({ page }) => {
  const bodies = [];
  let answer = { status: 204 };
  await page.route(`${base}/auth/reset-password`, (route) => { bodies.push(route.request().postDataJSON()); return route.fulfill(answer); });
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/reset-password?token=reset-token');
  const field = page.getByLabel('Новый пароль', { exact: true });
  await field.evaluate((input) => { input.removeAttribute('minlength'); input.removeAttribute('maxlength'); });
  await field.fill('short');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page.getByRole('alert')).toContainText('Пароль должен содержать минимум 8 символов');
  await field.fill('я'.repeat(37));
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page.getByRole('alert')).toContainText('Пароль слишком длинный');
  expect(bodies).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await field.fill('a-new-password');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page.getByRole('status')).toHaveText('Пароль изменён. Войдите с новым паролем.');
  expect(bodies).toEqual([{ token: 'reset-token', new_password: 'a-new-password' }]);
  await expect(page.getByLabel('Новый пароль', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Перейти ко входу' }).click();
  await expect(page).toHaveURL('/login');

  answer = invalidToken;
  await page.goto('/reset-password?token=old-token');
  await page.getByLabel('Новый пароль', { exact: true }).fill('a-new-password');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна или устарела');
  await expect(page.getByRole('link', { name: 'Запросить новую ссылку' })).toHaveAttribute('href', '/forgot-password');
  await page.goto('/reset-password');
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна или устарела');
  expect(bodies).toHaveLength(2);
});

test('forgot password shows the same message whatever the server answers and never hints at the account', async ({ page }) => {
  const sent = 'Если такой email зарегистрирован, мы отправили на него письмо со ссылкой для сброса пароля. Проверьте почту.';
  const bodies = [];
  let answer = { status: 202 };
  await page.route(`${base}/auth/forgot-password`, (route) => { bodies.push(route.request().postDataJSON()); return route.fulfill(answer); });
  for (const next of [{ status: 202 }, { status: 404, json: { detail: 'No such user' } }, { status: 500, body: 'error' }]) {
    answer = next;
    await page.goto('/login');
    await page.getByRole('link', { name: 'Забыли пароль?' }).click();
    await expect(page).toHaveURL('/forgot-password');
    // The URL changes before React swaps the page, and both pages have an "Email" field: wait for the new one.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сброс пароля');
    await page.getByLabel('Email', { exact: true }).fill('known@example.com');
    const before = bodies.length;
    await page.getByRole('button', { name: 'Отправить ссылку' }).click();
    await expect.poll(() => bodies.length, { message: 'the form must send exactly one request' }).toBe(before + 1);
    await expect(page.getByRole('status')).toHaveText(sent);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('No such user')).toHaveCount(0);
  }
  expect(bodies).toEqual(Array(3).fill({ email: 'known@example.com' }));
  // No answer at all is a connection problem, not a statement about the address.
  await page.unroute(`${base}/auth/forgot-password`);
  await page.route(`${base}/auth/forgot-password`, (route) => route.abort('failed'));
  await page.goto('/forgot-password');
  await page.getByLabel('Email', { exact: true }).fill('known@example.com');
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByRole('button', { name: 'Отправить ссылку' })).toBeEnabled();
});

test('an unverified account sees the reminder and can request the email once per minute', async ({ page }) => {
  await page.clock.install({ time: new Date('2030-01-01T10:00:00Z') });
  let requests = 0;
  await page.route(`${base}/tickets/me`, (route) => route.fulfill({ json: [] }));
  await page.route(`${base}/auth/resend-verification`, (route) => {
    requests += 1;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    return route.fulfill({ status: 202 });
  });
  await login(page, { ...user, email_verified: false });
  const banner = page.getByRole('region', { name: 'Напоминание о подтверждении email' });
  await expect(banner).toContainText('Подтвердите email: мы отправили письмо со ссылкой на fixture@example.com.');
  const resend = banner.getByRole('button', { name: 'Отправить письмо ещё раз' });
  await resend.click();
  await expect(banner).toContainText('Письмо отправлено. Повторно его можно запросить через минуту.');
  await expect(resend).toBeDisabled();
  // The limit follows the visitor to other pages.
  await page.getByRole('navigation').getByRole('link', { name: 'Мои билеты' }).click();
  await expect(page.getByRole('status')).toHaveText('Билетов пока нет. Выберите событие и получите бесплатный билет.');
  await expect(resend).toBeDisabled();
  await page.clock.runFor(59_000);
  await expect(resend).toBeDisabled();
  expect(requests).toBe(1);
  await page.clock.runFor(1_500);
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(resend).toBeDisabled();
  expect(requests).toBe(2);
});

test('the reminder disappears after the link is confirmed in the same session, and is absent for verified or older APIs', async ({ page }) => {
  await page.route(`${base}/auth/verify-email`, (route) => route.fulfill({ json: { ...user, email_verified: true } }));
  await login(page, { ...user, email_verified: false });
  const banner = page.getByRole('region', { name: 'Напоминание о подтверждении email' });
  await expect(banner).toBeVisible();
  await go(page, '/verify-email?token=good-token');
  await expect(page.getByRole('status')).toHaveText('Email подтверждён. Спасибо!');
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('navigation')).toContainText('Account Visitor');
  for (const me of [{ ...user, email_verified: true }, user]) {
    await login(page, me);
    await expect(page.getByRole('navigation')).toContainText('Account Visitor');
    await expect(banner).toHaveCount(0);
  }
});

test('sign-out clears the memory session without calling the server', async ({ page }) => {
  const calls = [];
  page.on('request', (request) => { if (request.url().startsWith(`${base}/auth/logout`)) calls.push(request.url()); });
  await login(page, user);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});
