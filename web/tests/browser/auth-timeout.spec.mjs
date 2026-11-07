import { test, expect } from '@playwright/test';

test('a stalled login releases the actual form and a second attempt succeeds', async ({ page }) => {
  let calls = 0;
  await page.route('http://localhost:8000/auth/login', (route) => {
    calls++;
    // First request deliberately never receives headers; the client owns its deadline.
    if (calls === 1) return;
    return route.fulfill({ json: { access_token: 'fixture-token', token_type: 'bearer' } });
  });
  await page.route('http://localhost:8000/auth/me', (route) => route.fulfill({ json: {
    id: 1, email: 'fixture@example.com', full_name: 'Recovered Visitor', role: 'attendee', is_active: true, created_at: '2030-01-01T00:00:00Z',
  } }));
  await page.route('http://localhost:8000/events', (route) => route.fulfill({ json: [] }));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер не ответил вовремя', { timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('navigation')).toContainText('Recovered Visitor');
  expect(calls).toBe(2);
});
