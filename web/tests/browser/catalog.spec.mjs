import { test, expect } from '@playwright/test';

// Test fixtures only: the application has no mock mode or fallback data.
const events = [
  { id: 42, organizer_id: 7, title: 'Вечер джаза', description: null, date: '2030-07-15T00:30:00Z', location: 'Алматы, Большой зал', capacity: 100, status: 'published', tickets_issued: 12, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' },
  { id: 43, organizer_id: 7, title: 'Лекция о музыке', description: 'Джаз', date: '2030-07-16T12:00:00Z', location: 'Джаз-клуб', capacity: 30, status: 'published', tickets_issued: 30, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' },
];
const endpoint = 'http://localhost:8000/events';

test('public GET loads cards; title search is local and links lead to the event', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await page.route('http://localhost:8000/events**', async (route) => {
    requests += 1;
    expect(route.request().url()).toBe(endpoint);
    expect(route.request().method()).toBe('GET');
    expect(Boolean(route.request().headers().authorization)).toBe(false);
    await gate;
    await route.fulfill({ json: events });
  });
  await page.route(`${endpoint}/42`, (route) => route.fulfill({ json: events[0] }));
  await page.goto('/events');
  await expect(page.getByRole('status')).toHaveText('Загружаем события…');
  await expect(page.getByText('Событий пока нет', { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Вечер джаза', exact: true })).toHaveAttribute('href', '/events/42');
  await expect(page.getByRole('article').first()).toContainText('Алматы, Большой зал');
  const loadedRequests = requests;
  await page.getByRole('searchbox').fill('  ДЖаЗ  ');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Вечер джаза', exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('Алматы');
  await expect(page.getByRole('status')).toContainText('Ничего не найдено');
  await expect(page.getByText('Событий пока нет', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Сбросить поиск' }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  expect(requests).toBe(loadedRequests);
  await page.getByRole('link', { name: 'Вечер джаза', exact: true }).click();
  await expect(page).toHaveURL('/events/42');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(events[0].title);
});

test('a successful empty array is displayed as an empty catalog', async ({ page }) => {
  await page.route(endpoint, (route) => route.fulfill({ json: [] }));
  await page.goto('/events');
  await expect(page.getByRole('status')).toContainText('Событий пока нет');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('searchbox').click();
  await page.getByRole('searchbox').pressSequentially('empty catalog query');
  await expect(page.getByRole('searchbox')).toHaveValue('empty catalog query');
  await expect(page.getByRole('status')).toContainText('Событий пока нет');
});

test('search accepts typing during loading and 405, preserves query through retry and filters without q', async ({ page }) => {
  let releaseFirst;
  let releaseRetry;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  let fail = true;
  let requests = 0;
  await page.route('http://localhost:8000/events**', async (route) => {
    requests++;
    expect(route.request().method()).toBe('GET');
    expect(route.request().url()).toBe(endpoint);
    const currentFailure = fail;
    await (currentFailure ? firstGate : retryGate);
    await route.fulfill(currentFailure
      ? { status: 405, headers: { Allow: 'POST' }, json: { detail: 'Method Not Allowed' } }
      : { json: events });
  });
  await page.goto('/events');
  const input = page.getByRole('searchbox');
  await expect(page.getByRole('status')).toContainText('Загружаем');
  await input.click();
  await input.pressSequentially('  ДЖ');
  releaseFirst();
  await expect(page.getByRole('alert')).toContainText('Каталог недоступен на подключённом сервере (HTTP 405)');
  await expect(page.getByRole('alert')).not.toContainText('Method Not Allowed');
  await expect(page.getByText('Событий пока нет', { exact: true })).toHaveCount(0);
  await input.pressSequentially('аЗ');
  await expect(input).toHaveValue('  ДЖаЗ');
  fail = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Загружаем');
  await expect(input).toHaveValue('  ДЖаЗ');
  await input.click();
  await input.pressSequentially('  ');
  releaseRetry();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toContainText('Вечер джаза');
  await expect(input).toHaveValue('  ДЖаЗ  ');
  const loadedRequests = requests;
  await input.pressSequentially('нет-совпадений');
  await expect(page.getByRole('status')).toContainText('Ничего не найдено');
  expect(requests).toBe(loadedRequests);
});

for (const failure of ['http', 'network', 'invalid-json-shape']) {
  test(`${failure} is an error, not an empty catalog; retry recovers`, async ({ page }) => {
    let fail = true;
    await page.route(endpoint, (route) => {
      if (!fail) return route.fulfill({ json: events });
      if (failure === 'network') return route.abort('failed');
      if (failure === 'http') return route.fulfill({ status: 503, json: { detail: 'Unavailable' } });
      return route.fulfill({ json: { items: [] } });
    });
    await page.goto('/events');
    await expect(page.getByRole('alert')).toContainText('Не удалось загрузить события');
    await expect(page.getByText('Событий пока нет', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).not.toContainText('[object Object]');
    fail = false;
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test.describe('mobile local time', () => {
  test.use({ viewport: { width: 375, height: 812 }, timezoneId: 'America/New_York' });
  test('cards fit 375px and convert the UTC date across the local day boundary', async ({ page }) => {
    await page.route(endpoint, (route) => route.fulfill({ json: [{ ...events[0], title: 'Очень длинное название музыкального события под открытым небом', location: 'ОченьДлинноеНазваниеМестаПроведенияБезПробелов'.repeat(3) }] }));
    await page.goto('/events');
    const date = page.locator('time');
    await expect(date).toHaveAttribute('datetime', events[0].date);
    await expect(date).toContainText('14 июля 2030');
    await expect(date).toContainText('20:30');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('searchbox')).toBeVisible();
    await page.screenshot({ path: 'test-results/catalog-mobile.png', fullPage: true });
  });
});
