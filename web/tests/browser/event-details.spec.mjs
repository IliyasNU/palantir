import { test, expect } from '@playwright/test';
import { eventDetails } from './event-fixture.mjs';

const endpoint = 'http://localhost:8000/events/42';

test('direct open, loading, fields, reload and safe guest return', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(endpoint, async (route) => {
    expect(route.request().method()).toBe('GET');
    expect(Boolean(route.request().headers().authorization)).toBe(false);
    await gate;
    await route.fulfill({ json: eventDetails });
  });
  await page.goto('/events/42');
  await expect(page.getByRole('status')).toHaveText('Загружаем событие…');
  release();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
  await expect(page.getByRole('article')).toContainText('Обсудим веб-приложения.');
  await expect(page.getByRole('article')).toContainText(eventDetails.location);
  await expect(page.locator('time')).toHaveAttribute('datetime', eventDetails.date);
  await expect(page.getByRole('article')).toContainText('Опубликовано');
  await expect(page.getByRole('article')).toContainText('Осталось мест: 88');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
  await page.getByRole('link', { name: 'Войти и вернуться к этому событию' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await page.getByRole('link', { name: 'Перейти ко входу' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
});

test('404 is a not-found state, not a generic API error', async ({ page }) => {
  await page.route(endpoint, (route) => route.fulfill({ status: 404, json: { detail: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } } }));
  await page.goto('/events/42');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Событие не найдено');
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
});

for (const failure of ['network', 'http']) {
  test(`${failure} error offers retry and recovers`, async ({ page }) => {
    let fail = true;
    await page.route(endpoint, (route) => {
      if (!fail) return route.fulfill({ json: eventDetails });
      return failure === 'network' ? route.abort('failed') : route.fulfill({ status: 503, body: 'Unavailable' });
    });
    await page.goto('/events/42');
    await expect(page.getByRole('alert')).toContainText('Не удалось загрузить событие');
    await expect(page.getByRole('article')).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
  });
}

for (const counters of [{ capacity: undefined, tickets_issued: undefined }, { capacity: '100', tickets_issued: -2 }]) {
  test(`unknown availability for ${JSON.stringify(counters)}`, async ({ page }) => {
    await page.route(endpoint, (route) => route.fulfill({ json: { ...eventDetails, ...counters } }));
    await page.goto('/events/42');
    await expect(page.getByRole('article')).toContainText('Доступность неизвестна');
    await expect(page.getByRole('article')).not.toContainText('Осталось мест:');
    await expect(page.getByRole('article')).not.toContainText('Свободных мест нет');
  });
}

for (const status of ['published', 'cancelled']) {
  test(`sold-out ${status} event keeps the action component enabled`, async ({ page }) => {
    await page.route('**/src/events/EventActions.tsx*', (route) => route.fulfill({
      contentType: 'text/javascript', body: 'export { EventActions } from "/tests/browser/fixtures/TicketAction.tsx";',
    }));
    await page.route(endpoint, (route) => route.fulfill({ json: { ...eventDetails, status, tickets_issued: 100 } }));
    await page.goto('/events/42');
    await expect(page.getByRole('article')).toContainText('Осталось мест: 0');
    await expect(page.getByRole('article')).toContainText('Свободных мест нет');
    if (status === 'cancelled') await expect(page.getByRole('article')).toContainText('Событие отменено');
    const action = page.getByRole('button', { name: 'Тест: открыть существующий билет' });
    await expect(action).toBeEnabled();
    await expect(action).toHaveAttribute('data-event-id', '42');
    await expect(action).toHaveAttribute('data-remaining', '0');
    await expect(action).toHaveAttribute('data-return-to', '/events/42');
    await action.click();
    await expect(page.getByRole('button', { name: 'Действие подключено' })).toBeVisible();
  });
}

test('late old-ID response cannot replace the newer event, even if fetch ignores abort', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = (input, options) => String(input).includes('/events/42')
      ? originalFetch(input, { ...options, signal: undefined }) : originalFetch(input, options);
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(endpoint, async (route) => { await gate; await route.fulfill({ json: eventDetails }); });
  await page.route('http://localhost:8000/events/43', (route) => route.fulfill({ json: { ...eventDetails, id: 43, title: 'Новое событие' } }));
  const oldRequest = page.waitForRequest(endpoint);
  await page.goto('/events/42');
  await oldRequest;
  await page.evaluate(() => {
    history.pushState({}, '', '/events/43');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новое событие');
  const oldResponse = page.waitForResponse(endpoint);
  release();
  await (await oldResponse).finished();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новое событие');
  await expect(page.getByRole('link', { name: 'Войти и вернуться к этому событию' })).toHaveAttribute('href', '/login?returnTo=%2Fevents%2F43');
});

for (const status of [401, 403]) {
  test(`authenticated detail ${status} uses the existing session policy`, async ({ page }) => {
    await page.route('http://localhost:8000/auth/login', (route) => route.fulfill({ json: { access_token: 'test-only-token', refresh_token: 'unused', token_type: 'bearer' } }));
    await page.route('http://localhost:8000/auth/me', (route) => route.fulfill({ json: { id: 1, email: 'fixture@example.com', full_name: 'Test Visitor', role: 'attendee', is_active: true, created_at: '2030-01-01T00:00:00Z' } }));
    let authorizedRequests = 0;
    await page.route(endpoint, (route) => {
      if (route.request().headers().authorization) {
        authorizedRequests += 1;
        return route.fulfill({ status, json: { detail: 'Access denied' } });
      }
      return route.fulfill({ json: eventDetails });
    });
    await page.goto('/login?returnTo=%2Fevents%2F42');
    await page.getByLabel('Email', { exact: true }).fill('fixture@example.com');
    await page.getByLabel('Пароль', { exact: true }).fill('test-only-password');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect.poll(() => authorizedRequests).toBeGreaterThan(0);
    if (status === 401) {
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
      await expect(page.getByRole('link', { name: 'Войти снова', exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('navigation')).toContainText('Test Visitor');
      await expect(page.getByText('У вас недостаточно прав для этого действия.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
    }
  });
}

test('detail stays readable at 375px and formats local time', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route(endpoint, (route) => route.fulfill({ json: eventDetails }));
  await page.goto('/events/42');
  await expect(page.getByRole('article')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const expectedDate = await page.evaluate((date) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(date)), eventDetails.date);
  await expect(page.locator('time')).toHaveText(expectedDate);
});
