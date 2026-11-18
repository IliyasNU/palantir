// Browser regressions for the findings of Alibi's reviews of PR #22, #24 and #25 that were still open on
// integration. Each title names its finding. Mocked HTTP only; any unmocked call to the API fails here.
import { test, expect } from '@playwright/test';
import { eventDetails } from './event-fixture.mjs';
import { withoutKazakhLocaleData } from './fixtures/no-kazakh-intl.mjs';

const base = 'http://localhost:8000';
const person = (role, id = 7) => ({ id, email: `${role}@example.com`, full_name: `Fixture ${role}`, role, is_active: true, created_at: '2030-01-01T00:00:00Z' });
const sent = 'Если такой email зарегистрирован, мы отправили на него письмо со ссылкой для сброса пароля. Проверьте почту.';

test.beforeEach(async ({ page }) => {
  await page.route((url) => url.origin === base, (route) => route.abort('failed'));
});

async function login(page, user, path) {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: user }));
  await page.goto(`/login?returnTo=${encodeURIComponent(path)}`);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toContainText(user.full_name);
}
// Client-side navigation: a reload would drop the memory-only session.
const go = (page, path) => page.evaluate((target) => {
  history.pushState(null, '', target);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);
const language = (page, name) => page.getByRole('button', { name, exact: true }).click();

test('#22.1 forgot-password: refusals that could depend on the account read like a success; only 5xx/404/429 are retryable', async ({ page }) => {
  let answer;
  const bodies = [];
  await page.route(`${base}/auth/forgot-password`, (route) => { bodies.push(route.request().postDataJSON()); return route.fulfill(answer); });
  const ask = async (email) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Отправить ссылку' }).click();
    await expect.poll(() => bodies.at(-1)?.email).toBe(email);
  };
  // A disabled, unknown or conflicting account must not be told apart from a registered one.
  for (const status of [202, 400, 401, 403, 409]) {
    answer = { status, json: { detail: 'This account is disabled' } };
    await ask(`known-${status}@example.com`);
    await expect(page.getByRole('status')).toHaveText(sent);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('disabled')).toHaveCount(0);
  }
  // Service failures: the same retryable text for a registered and an unknown address.
  for (const status of [404, 500, 503]) {
    answer = { status, body: 'error' };
    const texts = [];
    for (const email of ['known@example.com', 'nobody@example.com']) {
      await ask(email);
      await expect(page.getByRole('alert')).toHaveText('Сервер временно недоступен. Попробуйте позже.');
      await expect(page.getByRole('status')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Отправить ссылку' })).toBeEnabled();
      texts.push(await page.getByRole('alert').textContent());
    }
    expect(new Set(texts).size).toBe(1);
  }
  answer = { status: 429, json: { detail: { code: 'TOO_MANY_REQUESTS' } } };
  await ask('known@example.com');
  await expect(page.getByRole('alert')).toHaveText('Слишком много запросов. Попробуйте немного позже.');
  answer = { status: 422, json: { detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email address' }] } };
  await ask('known@example.com');
  await expect(page.getByRole('alert')).toHaveText('Проверьте адрес email: сервер не принял его формат.');
  // The retry after a failure goes through and then shows the neutral text.
  answer = { status: 202 };
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(page.getByRole('status')).toHaveText(sent);
});

test('#22.2 a reset request still pending for an old link cannot mark a newer link as done', async ({ page }) => {
  let finishOld;
  const tokens = [];
  await page.route(`${base}/auth/reset-password`, (route) => {
    const { token } = route.request().postDataJSON();
    tokens.push(token);
    if (token === 'old') return new Promise((resolve) => { finishOld = () => route.fulfill({ status: 204 }).catch(() => {}).then(resolve); });
    return route.fulfill({ status: 400, json: { detail: { code: 'INVALID_TOKEN' } } });
  });
  await page.goto('/reset-password?token=old');
  await page.getByLabel('Новый пароль', { exact: true }).fill('new-password');
  await page.getByLabel('Повторите пароль', { exact: true }).fill('new-password');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect.poll(() => typeof finishOld).toBe('function');
  await go(page, '/reset-password?token=fresh');
  await expect(page.getByRole('button', { name: 'Сохранить пароль' })).toBeEnabled();
  await finishOld();
  await page.waitForTimeout(300);
  await expect(page.getByText('Пароль изменён')).toHaveCount(0);
  await expect(page.getByLabel('Новый пароль', { exact: true })).toBeVisible();
  expect(tokens).toEqual(['old']);
});

test('#24.1 the reactivation step offers "keep suspended", not "do not suspend"', async ({ page }) => {
  let writes = 0;
  const suspended = { ...person('attendee', 11), email: 'inactive@example.com', is_active: false };
  await page.route(`${base}/admin/users?*`, (route) => route.fulfill({ json: [suspended] }));
  await page.route(`${base}/admin/users/11/reactivate`, (route) => { writes++; return route.fulfill({ json: { ...suspended, is_active: true } }); });
  await login(page, person('admin', 1), '/events');
  await go(page, '/admin/users');
  const row = page.getByRole('row').filter({ hasText: 'inactive@example.com' });
  await row.getByRole('button', { name: 'Разблокировать: inactive@example.com' }).click();
  await expect(row.getByRole('button', { name: 'Не блокировать' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Оставить блокировку', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Разблокировать: inactive@example.com' })).toBeVisible();
  expect(writes).toBe(0);
});

test('#24.2 another administrator has no suspension control, checked once the rows are on screen', async ({ page }) => {
  const rows = [{ ...person('admin', 8), full_name: 'Other Admin', email: 'other-admin@example.com' }, { ...person('organizer', 9), email: 'org@example.com' }];
  await page.route(`${base}/admin/users?*`, (route) => route.fulfill({ json: rows }));
  await login(page, person('admin', 1), '/events');
  await go(page, '/admin/users');
  const other = page.getByRole('row').filter({ hasText: 'other-admin@example.com' });
  // Wait for the data first: an empty table would pass a "no buttons" check vacuously.
  await expect(other).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'org@example.com' }).getByRole('button', { name: 'Заблокировать: org@example.com' })).toBeVisible();
  await expect(other.getByRole('button')).toHaveCount(0);
  await expect(other.getByRole('cell').last()).toHaveText('Администратор');
});

test('#25.1 errors and notices already on screen follow a language switch without a new request', async ({ page }) => {
  // A malformed catalogue is a local, non-API text: it was frozen in the language of the moment.
  let catalog = 0;
  await page.route(`${base}/events`, (route) => { catalog++; return route.fulfill({ json: { unexpected: true } }); });
  await page.goto('/events');
  await expect(page.getByRole('alert')).toContainText('Сервер вернул некорректный список событий');
  // The dev server's StrictMode may load twice; what matters is that the switch adds nothing.
  const loaded = catalog;
  await language(page, 'English');
  await expect(page.getByRole('alert')).toContainText('The server returned an invalid event list');
  expect(catalog).toBe(loaded);
  await language(page, 'Русский');

  // A ticket list failure on a signed-in page.
  let tickets = 0;
  await page.route(`${base}/tickets/me`, (route) => { tickets++; return route.fulfill({ status: 503 }); });
  await login(page, person('attendee'), '/tickets');
  await expect(page.getByRole('alert')).toContainText('Сервер временно недоступен');
  const before = tickets;
  await language(page, 'Қазақша');
  await expect(page.getByRole('alert')).toContainText('Сервер уақытша қолжетімсіз');
  await language(page, 'English');
  await expect(page.getByRole('alert')).toContainText('The server is temporarily unavailable');
  expect(tickets).toBe(before);
  await language(page, 'Русский');

  // A local form check on the reset page.
  await go(page, '/reset-password?token=fresh');
  await page.getByLabel('Новый пароль', { exact: true }).fill('new-password');
  await page.getByLabel('Повторите пароль', { exact: true }).fill('other-password');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page.getByRole('alert')).toContainText('Пароли не совпадают');
  await language(page, 'English');
  await expect(page.getByRole('alert')).toContainText('Passwords do not match');
});

test('#25.1 the organizer editor notice follows a language switch', async ({ page }) => {
  const event = { ...eventDetails, status: 'draft', suspended: false };
  await page.route(`${base}/events/mine`, (route) => route.fulfill({ json: [] }));
  await page.route(`${base}/events`, (route) => route.request().method() === 'POST' ? route.fulfill({ status: 201, json: event }) : route.fulfill({ json: [] }));
  await page.route(`${base}/events/42`, (route) => route.fulfill({ json: event }));
  await login(page, person('organizer'), '/organizer/events/new');
  await page.getByLabel('Название', { exact: true }).fill(event.title);
  await page.getByLabel('Дата и время начала', { exact: true }).fill('2030-07-15T12:00');
  await page.getByLabel('Место проведения', { exact: true }).fill(event.location);
  await page.getByLabel('Вместимость', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Создать черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик создан' })).toBeVisible();
  await language(page, 'English');
  await expect(page.getByRole('status').filter({ hasText: 'Draft created' })).toBeVisible();
});

test('#25.1 a local admin filter check follows a language switch', async ({ page }) => {
  await page.route(`${base}/admin/action-log?*`, (route) => route.fulfill({ json: [] }));
  await login(page, person('admin', 1), '/events');
  await go(page, '/admin/action-log');
  await page.getByLabel('ID события', { exact: true }).fill('abc');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.getByRole('alert')).toHaveText('ID события: целое положительное число.');
  await language(page, 'English');
  await expect(page.getByRole('alert')).toHaveText('Event ID: a positive whole number.');
});

test('#25.2 server validation in the organizer editor is translated, not FastAPI English', async ({ page }) => {
  await page.route(`${base}/events/mine`, (route) => route.fulfill({ json: [] }));
  await page.route(`${base}/events`, (route) => route.fulfill({ status: 422,
    json: { detail: [{ loc: ['body', 'title'], msg: 'String should have at least 3 characters', type: 'string_too_short' }] } }));
  await login(page, person('organizer'), '/organizer/events/new');
  await page.getByLabel('Название', { exact: true }).fill('Valid title');
  await page.getByLabel('Дата и время начала', { exact: true }).fill('2030-07-15T12:00');
  await page.getByLabel('Место проведения', { exact: true }).fill('Hall');
  await page.getByLabel('Вместимость', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Создать черновик' }).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте введённые данные.');
  await expect(page.getByRole('alert')).not.toContainText('String should have');
  await language(page, 'Қазақша');
  await expect(page.getByRole('alert')).not.toContainText('String should have');
  await expect(page.getByRole('alert')).toContainText('Енгізілген деректерді тексеріңіз.');
});

const pricedEvent = () => {
  const types = [100000, 100050].map((price_tiyn, index) => ({ id: index + 1, event_id: 42, name: `Type ${index + 1}`, description: null,
    quantity: 5, tickets_issued: 0, remaining: 5, price_tiyn, sales_start: null, sales_end: null, order_limit: 1, hidden: false }));
  return { ...eventDetails, date: '2030-11-15T12:00:00Z', ticket_types: types };
};

test('#25.3 without Kazakh ICU data, Kazakh prices still group with spaces and omit decimals for whole tenge', async ({ page }) => {
  await page.addInitScript(withoutKazakhLocaleData);
  const event = pricedEvent();
  await page.route(`${base}/events/42`, (route) => route.fulfill({ json: event }));
  await page.goto('/events/42');
  await language(page, 'Қазақша');
  const prices = page.getByRole('region', { name: 'Билет түрлері' });
  await expect(prices).toContainText(/Type 1 — 1\s000\s₸/);
  await expect(prices).toContainText(/Type 2 — 1\s000,50\s₸/);
  await expect(prices).not.toContainText('1,000');
  await language(page, 'English');
  const english = page.getByRole('region', { name: 'Ticket types' });
  await expect(english).toContainText('1,000 ₸');
  await expect(english).toContainText('1,000.50 ₸');
});

test('#25.4 without Kazakh ICU data, Kazakh dates are readable in the catalogue and in the admin suspension column', async ({ page }) => {
  await page.addInitScript(withoutKazakhLocaleData);
  const event = pricedEvent();
  await page.route(`${base}/events`, (route) => route.fulfill({ json: [event] }));
  await page.route(`${base}/admin/events?*`, (route) => route.fulfill({ json: [{ ...event, suspended: true, suspended_at: '2030-11-15T12:00:00Z' }] }));
  await login(page, person('admin', 1), '/events');
  await language(page, 'Қазақша');
  // The emulation itself reproduces the review's Edge output.
  expect(await page.evaluate(() => new Date('2030-11-15T12:00:00Z').toLocaleString('kk-KZ'))).toMatch(/^2030 M11 15/);
  await expect(page.locator('time')).toContainText('15 қараша 2030');
  await go(page, '/admin/events');
  const cell = page.getByRole('cell', { name: /Бұғатталған уақыты/ });
  await expect(cell).toContainText('15 қараша 2030');
  await expect(page.getByRole('table')).not.toContainText('M11');
});
